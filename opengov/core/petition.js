/**
 * core/petition.js — Petition & Signature System
 *
 * Authenticated users can sign petitions to support a proposal being put
 * to a national or state vote. Each petition requires 300 signatures from
 * authenticated users AFTER they have been shown all implications of the
 * proposal.
 *
 * The signature is only valid if:
 *   1. The signer is a registered, non-revoked identity
 *   2. The signer has acknowledged all implications (signed the implications hash)
 *   3. The signer has not already signed this petition
 *
 * Once 300 valid signatures are collected, the proposal automatically
 * transitions from PETITION -> OPEN (eligible for voting).
 */

"use strict";

const crypto = require("./crypto");
const { LedgerEntry } = require("./ledger");
const { ProposalState } = require("./proposal");

const DEFAULT_SIGNATURE_THRESHOLD = 300;

// ---------------------------------------------------------------------------
// Petition Signature
// ---------------------------------------------------------------------------

class PetitionSignature {
  constructor({
    signerFingerprint,
    proposalId,
    implicationsHash,
    acknowledgementSignature,
    petitionSignature,
    timestamp,
  }) {
    this.id = crypto.generateId();
    this.signerFingerprint = signerFingerprint;
    this.proposalId = proposalId;
    this.implicationsHash = implicationsHash;
    this.acknowledgementSignature = acknowledgementSignature;
    this.petitionSignature = petitionSignature;
    this.timestamp = timestamp || Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      signerFingerprint: this.signerFingerprint,
      proposalId: this.proposalId,
      implicationsHash: this.implicationsHash,
      acknowledgementSignature: this.acknowledgementSignature,
      petitionSignature: this.petitionSignature,
      timestamp: this.timestamp,
    };
  }
}

// ---------------------------------------------------------------------------
// Petition
// ---------------------------------------------------------------------------

class Petition {
  constructor({ proposalId, jurisdiction, threshold }) {
    this.proposalId = proposalId;
    this.jurisdiction = jurisdiction || "national";
    this.threshold = threshold || DEFAULT_SIGNATURE_THRESHOLD;
    this.signatures = new Map(); // signerFingerprint -> PetitionSignature
    this.thresholdMet = false;
    this.thresholdMetAt = null;
    this.createdAt = Date.now();
  }

  signatureCount() {
    return this.signatures.size;
  }

  remaining() {
    return Math.max(0, this.threshold - this.signatures.size);
  }

  toJSON() {
    return {
      proposalId: this.proposalId,
      jurisdiction: this.jurisdiction,
      threshold: this.threshold,
      signatureCount: this.signatures.size,
      remaining: this.remaining(),
      thresholdMet: this.thresholdMet,
      thresholdMetAt: this.thresholdMetAt,
      createdAt: this.createdAt,
      signatures: [...this.signatures.values()].map((s) => s.toJSON()),
    };
  }
}

// ---------------------------------------------------------------------------
// Petition Manager
// ---------------------------------------------------------------------------

class PetitionManager {
  constructor(ledger, identityRegistry, proposalRegistry) {
    this.ledger = ledger;
    this.identityRegistry = identityRegistry;
    this.proposalRegistry = proposalRegistry;
    this.petitions = new Map(); // proposalId -> Petition
  }

  /**
   * Create a petition for a proposal. The proposal must be in PETITION state.
   */
  createPetition(proposalId, threshold) {
    const proposal = this.proposalRegistry.get(proposalId);
    if (!proposal) throw new Error("Proposal not found");
    if (proposal.state !== ProposalState.PETITION) {
      throw new Error(
        `Proposal must be in PETITION state, currently: ${proposal.state}`,
      );
    }

    const petition = new Petition({
      proposalId,
      jurisdiction: proposal.jurisdiction,
      threshold: threshold || DEFAULT_SIGNATURE_THRESHOLD,
    });
    this.petitions.set(proposalId, petition);
    return petition;
  }

  /**
   * Sign a petition. The signer must:
   *  1. Be a registered, non-revoked identity
   *  2. Prove they read the implications by signing the implications hash
   *  3. Not have already signed this petition
   *
   * @param {string} proposalId
   * @param {string} signerFingerprint
   * @param {string} signerPrivateKey
   * @returns {object} { signature, petition, thresholdMet }
   */
  sign(proposalId, signerFingerprint, signerPrivateKey) {
    const petition = this.petitions.get(proposalId);
    if (!petition) throw new Error("No petition found for this proposal");

    if (petition.thresholdMet) {
      throw new Error("Petition threshold already met");
    }

    // Verify signer identity
    const identity = this.identityRegistry.get(signerFingerprint);
    if (!identity) throw new Error("Signer is not registered");
    if (identity.revoked) throw new Error("Signer identity is revoked");

    // Duplicate check
    if (petition.signatures.has(signerFingerprint)) {
      throw new Error("Signer has already signed this petition");
    }

    // Get proposal implications
    const proposal = this.proposalRegistry.get(proposalId);
    if (!proposal) throw new Error("Proposal not found");

    if (!proposal.implications || proposal.implications.length === 0) {
      throw new Error("Proposal has no implications — cannot sign");
    }

    // The signer must sign the hash of the implications, proving they had
    // access to (and presumably read) them before signing.
    const implicationsHash = crypto.hash(proposal.implications);
    const acknowledgementSignature = crypto.sign(
      "I_ACKNOWLEDGE_IMPLICATIONS:" + implicationsHash,
      signerPrivateKey,
    );

    // The actual petition signature
    const petitionContent = crypto.stableStringify({
      action: "PETITION_SIGN",
      proposalId,
      implicationsHash,
      signer: signerFingerprint,
    });
    const petitionSignature = crypto.sign(petitionContent, signerPrivateKey);

    const sig = new PetitionSignature({
      signerFingerprint,
      proposalId,
      implicationsHash,
      acknowledgementSignature,
      petitionSignature,
    });
    petition.signatures.set(signerFingerprint, sig);

    // Record on ledger
    const entryData = {
      type: "PETITION_SIGN",
      payload: {
        proposalId,
        signatureId: sig.id,
        implicationsHash,
        signatureCount: petition.signatureCount(),
        threshold: petition.threshold,
      },
      actorId: signerFingerprint,
      timestamp: Date.now(),
    };
    entryData.signature = crypto.sign(
      crypto.stableStringify({
        type: entryData.type,
        payload: entryData.payload,
        actorId: entryData.actorId,
        timestamp: entryData.timestamp,
      }),
      signerPrivateKey,
    );
    this.ledger.addEntry(new LedgerEntry(entryData));

    // Check if threshold met
    const thresholdMet = petition.signatureCount() >= petition.threshold;
    if (thresholdMet && !petition.thresholdMet) {
      petition.thresholdMet = true;
      petition.thresholdMetAt = Date.now();

      // Record threshold event on ledger
      const thresholdEntry = new LedgerEntry({
        type: "PETITION_THRESHOLD_MET",
        payload: {
          proposalId,
          signatureCount: petition.signatureCount(),
          threshold: petition.threshold,
        },
        actorId: "SYSTEM",
        signature: crypto.hash({
          proposalId,
          signatureCount: petition.signatureCount(),
        }),
        timestamp: Date.now(),
      });
      this.ledger.addEntry(thresholdEntry);

      // Auto-transition proposal to OPEN
      proposal.transitionTo(ProposalState.OPEN);
    }

    return {
      signature: sig,
      petition: {
        signatureCount: petition.signatureCount(),
        remaining: petition.remaining(),
        thresholdMet: petition.thresholdMet,
      },
    };
  }

  /**
   * Verify a specific petition signature.
   */
  verifySignature(proposalId, signerFingerprint) {
    const petition = this.petitions.get(proposalId);
    if (!petition) return { valid: false, error: "No petition" };

    const sig = petition.signatures.get(signerFingerprint);
    if (!sig) return { valid: false, error: "Signature not found" };

    const identity = this.identityRegistry.get(signerFingerprint);
    if (!identity) return { valid: false, error: "Identity not found" };

    const proposal = this.proposalRegistry.get(proposalId);
    const implicationsHash = crypto.hash(proposal.implications);

    // Verify acknowledgement
    const ackValid = crypto.verify(
      "I_ACKNOWLEDGE_IMPLICATIONS:" + implicationsHash,
      sig.acknowledgementSignature,
      identity.publicKey,
    );

    // Verify petition signature
    const petitionContent = crypto.stableStringify({
      action: "PETITION_SIGN",
      proposalId,
      implicationsHash,
      signer: signerFingerprint,
    });
    const petitionValid = crypto.verify(
      petitionContent,
      sig.petitionSignature,
      identity.publicKey,
    );

    return {
      valid: ackValid && petitionValid,
      acknowledgementValid: ackValid,
      petitionSignatureValid: petitionValid,
    };
  }

  getPetition(proposalId) {
    return this.petitions.get(proposalId) || null;
  }

  stats() {
    let active = 0;
    let completed = 0;
    let totalSignatures = 0;
    for (const p of this.petitions.values()) {
      if (p.thresholdMet) completed++;
      else active++;
      totalSignatures += p.signatureCount();
    }
    return { total: this.petitions.size, active, completed, totalSignatures };
  }
}

module.exports = {
  DEFAULT_SIGNATURE_THRESHOLD,
  PetitionSignature,
  Petition,
  PetitionManager,
};
