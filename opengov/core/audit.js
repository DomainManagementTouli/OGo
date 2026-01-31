/**
 * core/audit.js — Transparency & Audit Layer
 *
 * Provides complete auditability of every action in the system.
 * Any citizen (or external auditor) can:
 *   - Verify the entire chain integrity
 *   - Verify any individual entry's inclusion via Merkle proof
 *   - Verify any vote's commitment–reveal integrity
 *   - Verify any petition signature
 *   - Get a complete activity log for any identity
 *   - Get a complete history for any proposal
 *   - Export the full ledger for independent verification
 *
 * This module does NOT require any privileged access — it operates purely
 * on the public ledger data, demonstrating that the system is fully
 * transparent by design.
 */

"use strict";

const crypto = require("./crypto");

class AuditEngine {
  constructor(ledger, identityRegistry, proposalRegistry, votingManager, petitionManager) {
    this.ledger = ledger;
    this.identityRegistry = identityRegistry;
    this.proposalRegistry = proposalRegistry;
    this.votingManager = votingManager;
    this.petitionManager = petitionManager;
  }

  /**
   * Full chain verification. Returns detailed results.
   */
  verifyChainIntegrity() {
    const result = this.ledger.verifyChain();
    return {
      ...result,
      blockCount: this.ledger.chain.length,
      genesisHash: this.ledger.chain[0].hash,
      latestHash: this.ledger.latestBlock().hash,
      timestamp: Date.now(),
    };
  }

  /**
   * Verify a specific entry's inclusion in the ledger via Merkle proof.
   */
  verifyEntryInclusion(entryId) {
    const proof = this.ledger.getInclusionProof(entryId);
    if (!proof) return { found: false };

    const verified = crypto.MerkleTree.verifyProof(
      proof.leafHash,
      proof.proof,
      proof.merkleRoot,
    );

    return {
      found: true,
      verified,
      blockIndex: proof.blockIndex,
      merkleRoot: proof.merkleRoot,
      proofSteps: proof.proof.length,
    };
  }

  /**
   * Verify a ledger entry's signature against the actor's public key.
   */
  verifyEntrySignature(entryId) {
    const entry = this.ledger.getEntry(entryId);
    if (!entry) return { found: false };

    // System entries don't have standard signatures
    if (entry.actorId === "SYSTEM") {
      return { found: true, actorId: "SYSTEM", signatureValid: true, note: "System entry" };
    }

    const identity = this.identityRegistry.get(entry.actorId);
    if (!identity) {
      return { found: true, actorId: entry.actorId, signatureValid: false, error: "Identity not found" };
    }

    const signable = entry.signableContent();
    const valid = crypto.verify(signable, entry.signature, identity.publicKey);

    return {
      found: true,
      actorId: entry.actorId,
      signatureValid: valid,
      entryType: entry.type,
      timestamp: entry.timestamp,
    };
  }

  /**
   * Get a complete activity timeline for an identity.
   */
  getIdentityActivity(fingerprint) {
    const entries = this.ledger.getEntriesByActor(fingerprint);
    return entries.map((e) => ({
      entryId: e.id,
      type: e.type,
      timestamp: e.timestamp,
      payloadSummary: this._summarisePayload(e),
    }));
  }

  /**
   * Get a complete history for a proposal: creation, edits, signatures, votes, tally.
   */
  getProposalHistory(proposalId) {
    const allEntries = [];
    for (let bi = 1; bi < this.ledger.chain.length; bi++) {
      for (const entry of this.ledger.chain[bi].entries) {
        if (
          entry.payload &&
          entry.payload.proposalId === proposalId
        ) {
          allEntries.push({
            entryId: entry.id,
            type: entry.type,
            actorId: entry.actorId,
            timestamp: entry.timestamp,
            payload: entry.payload,
          });
        }
      }
    }
    return allEntries.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Verify all votes for a proposal — re-tally from the ledger.
   */
  verifyProposalVotes(proposalId) {
    const session = this.votingManager.getSession(proposalId);
    if (!session) return { error: "No voting session found" };

    // Re-count from revealed ballots on the ledger
    const revealEntries = [];
    for (let bi = 1; bi < this.ledger.chain.length; bi++) {
      for (const entry of this.ledger.chain[bi].entries) {
        if (
          entry.type === "VOTE_REVEAL" &&
          entry.payload.proposalId === proposalId
        ) {
          revealEntries.push(entry);
        }
      }
    }

    const reCounts = { YEA: 0, NAY: 0, ABSTAIN: 0 };
    for (const entry of revealEntries) {
      reCounts[entry.payload.choice]++;
    }

    const officialTally = session.tallyResult;
    const matches = officialTally
      ? reCounts.YEA === officialTally.counts.YEA &&
        reCounts.NAY === officialTally.counts.NAY &&
        reCounts.ABSTAIN === officialTally.counts.ABSTAIN
      : null;

    return {
      proposalId,
      ledgerRevealCount: revealEntries.length,
      reCounts,
      officialCounts: officialTally ? officialTally.counts : null,
      tallyMatchesLedger: matches,
    };
  }

  /**
   * Verify all petition signatures for a proposal.
   */
  verifyPetitionSignatures(proposalId) {
    const petition = this.petitionManager.getPetition(proposalId);
    if (!petition) return { error: "No petition found" };

    const results = [];
    for (const [fp] of petition.signatures) {
      const verification = this.petitionManager.verifySignature(proposalId, fp);
      results.push({ signer: fp, ...verification });
    }

    const allValid = results.every((r) => r.valid);
    return {
      proposalId,
      totalSignatures: results.length,
      allValid,
      results,
    };
  }

  /**
   * Export a complete transparency report.
   */
  generateTransparencyReport() {
    const chainVerification = this.verifyChainIntegrity();

    return {
      generatedAt: new Date().toISOString(),
      system: "OpenGov Decentralized Governance",
      chain: {
        valid: chainVerification.valid,
        blocks: chainVerification.blockCount,
        genesisHash: chainVerification.genesisHash,
        latestHash: chainVerification.latestHash,
      },
      identities: this.identityRegistry.stats(),
      proposals: this.proposalRegistry.stats(),
      voting: this.votingManager.stats(),
      petitions: this.petitionManager.stats(),
      ledger: this.ledger.stats(),
    };
  }

  /**
   * Export the full ledger as JSON for independent verification.
   */
  exportLedger() {
    return this.ledger.toJSON();
  }

  _summarisePayload(entry) {
    switch (entry.type) {
      case "REGISTER":
        return `Registered identity ${entry.payload.fingerprint}`;
      case "PROPOSAL_CREATE":
        return `Created proposal: ${entry.payload.title}`;
      case "PROPOSAL_STATE_CHANGE":
        return `Proposal ${entry.payload.proposalId} -> ${entry.payload.newState}`;
      case "VOTE_COMMIT":
        return `Committed vote on proposal ${entry.payload.proposalId}`;
      case "VOTE_REVEAL":
        return `Revealed vote: ${entry.payload.choice}`;
      case "PETITION_SIGN":
        return `Signed petition for proposal ${entry.payload.proposalId} (${entry.payload.signatureCount}/${entry.payload.threshold})`;
      default:
        return entry.type;
    }
  }
}

module.exports = { AuditEngine };
