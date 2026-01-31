/**
 * core/identity.js — Decentralized Identity & Authentication
 *
 * Each citizen generates their own Ed25519 key pair locally. The public key
 * fingerprint becomes their unique identifier. Registration is recorded on the
 * ledger, making it publicly verifiable without a central authority.
 *
 * Authentication uses challenge–response: the system sends a random nonce,
 * the citizen signs it with their private key, and any node can verify the
 * signature against the registered public key.
 *
 * Privacy: The system supports pseudonymous participation — the public key is
 * the identity. Optional verified-identity attestations can be added later
 * by trusted attestors (e.g. for one-person-one-vote guarantees), but the
 * core protocol does not require real-name disclosure.
 */

"use strict";

const crypto = require("./crypto");
const { LedgerEntry } = require("./ledger");

// ---------------------------------------------------------------------------
// Identity record
// ---------------------------------------------------------------------------

class Identity {
  constructor({ publicKey, alias, jurisdiction, registeredAt }) {
    this.publicKey = publicKey;
    this.fingerprint = crypto.fingerprintPublicKey(publicKey);
    this.alias = alias || "anonymous";
    this.jurisdiction = jurisdiction || "global"; // e.g. "US", "US-CA"
    this.registeredAt = registeredAt || Date.now();
    this.attestations = []; // third-party attestations
    this.revoked = false;
  }

  toJSON() {
    return {
      publicKey: this.publicKey,
      fingerprint: this.fingerprint,
      alias: this.alias,
      jurisdiction: this.jurisdiction,
      registeredAt: this.registeredAt,
      attestations: this.attestations,
      revoked: this.revoked,
    };
  }
}

// ---------------------------------------------------------------------------
// Attestation — optional identity verification by a trusted party
// ---------------------------------------------------------------------------

class Attestation {
  /**
   * @param {string} subjectFingerprint  — identity being attested
   * @param {string} attestorFingerprint — attestor identity
   * @param {string} claim               — e.g. "unique-human", "jurisdiction:US-CA"
   * @param {string} signature           — attestor's signature over the claim
   */
  constructor({ subjectFingerprint, attestorFingerprint, claim, signature }) {
    this.id = crypto.generateId();
    this.subjectFingerprint = subjectFingerprint;
    this.attestorFingerprint = attestorFingerprint;
    this.claim = claim;
    this.signature = signature;
    this.timestamp = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Identity Registry — manages registration, lookup, and authentication
// ---------------------------------------------------------------------------

class IdentityRegistry {
  /**
   * @param {Ledger} ledger
   */
  constructor(ledger) {
    this.ledger = ledger;
    this.identities = new Map(); // fingerprint -> Identity
    this.pendingChallenges = new Map(); // fingerprint -> { nonce, expiresAt }
    this.trustedAttestors = new Set(); // fingerprints allowed to attest
  }

  /**
   * Register a new identity. The registration is signed by the registrant
   * and recorded on the ledger.
   */
  register({ publicKey, alias, jurisdiction, privateKey }) {
    const fingerprint = crypto.fingerprintPublicKey(publicKey);

    if (this.identities.has(fingerprint)) {
      throw new Error(`Identity ${fingerprint} already registered`);
    }

    const identity = new Identity({
      publicKey,
      alias,
      jurisdiction,
    });

    // Create and sign the ledger entry
    const entryData = {
      type: "REGISTER",
      payload: identity.toJSON(),
      actorId: fingerprint,
      timestamp: Date.now(),
    };
    const signature = crypto.sign(
      crypto.stableStringify({
        type: entryData.type,
        payload: entryData.payload,
        actorId: entryData.actorId,
        timestamp: entryData.timestamp,
      }),
      privateKey,
    );
    entryData.signature = signature;

    const entry = new LedgerEntry(entryData);
    this.ledger.addEntry(entry);
    this.identities.set(fingerprint, identity);

    return { identity, entryId: entry.id };
  }

  /**
   * Look up an identity by fingerprint.
   */
  get(fingerprint) {
    return this.identities.get(fingerprint) || null;
  }

  /**
   * Issue an authentication challenge (random nonce).
   */
  issueChallenge(fingerprint) {
    if (!this.identities.has(fingerprint)) {
      throw new Error(`Unknown identity: ${fingerprint}`);
    }
    const nonce = crypto.generateNonce();
    this.pendingChallenges.set(fingerprint, {
      nonce,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    });
    return nonce;
  }

  /**
   * Verify a challenge response. Returns true if the signature is valid.
   */
  verifyChallenge(fingerprint, signedNonce) {
    const challenge = this.pendingChallenges.get(fingerprint);
    if (!challenge) return false;
    if (Date.now() > challenge.expiresAt) {
      this.pendingChallenges.delete(fingerprint);
      return false;
    }

    const identity = this.identities.get(fingerprint);
    if (!identity || identity.revoked) return false;

    const valid = crypto.verify(challenge.nonce, signedNonce, identity.publicKey);
    this.pendingChallenges.delete(fingerprint);
    return valid;
  }

  /**
   * Add an attestation to an identity (e.g. "this is a unique human").
   */
  addAttestation({
    subjectFingerprint,
    attestorFingerprint,
    claim,
    attestorPrivateKey,
  }) {
    if (!this.trustedAttestors.has(attestorFingerprint)) {
      throw new Error(`Attestor ${attestorFingerprint} is not trusted`);
    }
    const subject = this.identities.get(subjectFingerprint);
    if (!subject) throw new Error(`Unknown subject: ${subjectFingerprint}`);

    const signableContent = crypto.stableStringify({
      subject: subjectFingerprint,
      claim,
    });
    const signature = crypto.sign(signableContent, attestorPrivateKey);

    const attestation = new Attestation({
      subjectFingerprint,
      attestorFingerprint,
      claim,
      signature,
    });
    subject.attestations.push(attestation);

    // Record on ledger
    const entryData = {
      type: "ATTESTATION",
      payload: {
        attestationId: attestation.id,
        subject: subjectFingerprint,
        attestor: attestorFingerprint,
        claim,
      },
      actorId: attestorFingerprint,
      timestamp: Date.now(),
    };
    entryData.signature = crypto.sign(
      crypto.stableStringify({
        type: entryData.type,
        payload: entryData.payload,
        actorId: entryData.actorId,
        timestamp: entryData.timestamp,
      }),
      attestorPrivateKey,
    );

    const entry = new LedgerEntry(entryData);
    this.ledger.addEntry(entry);

    return attestation;
  }

  /**
   * Check whether an identity has a specific attestation claim.
   */
  hasAttestation(fingerprint, claim) {
    const identity = this.identities.get(fingerprint);
    if (!identity) return false;
    return identity.attestations.some((a) => a.claim === claim);
  }

  /**
   * Revoke an identity (self-revocation — signed by the identity itself).
   */
  revoke(fingerprint, privateKey) {
    const identity = this.identities.get(fingerprint);
    if (!identity) throw new Error(`Unknown identity: ${fingerprint}`);

    identity.revoked = true;

    const entryData = {
      type: "REVOKE_IDENTITY",
      payload: { fingerprint },
      actorId: fingerprint,
      timestamp: Date.now(),
    };
    entryData.signature = crypto.sign(
      crypto.stableStringify({
        type: entryData.type,
        payload: entryData.payload,
        actorId: entryData.actorId,
        timestamp: entryData.timestamp,
      }),
      privateKey,
    );
    const entry = new LedgerEntry(entryData);
    this.ledger.addEntry(entry);

    return true;
  }

  /**
   * Mark a fingerprint as a trusted attestor.
   */
  addTrustedAttestor(fingerprint) {
    this.trustedAttestors.add(fingerprint);
  }

  /**
   * Return all registered (non-revoked) identities for a jurisdiction.
   */
  getByJurisdiction(jurisdiction) {
    const result = [];
    for (const identity of this.identities.values()) {
      if (!identity.revoked && identity.jurisdiction === jurisdiction) {
        result.push(identity);
      }
    }
    return result;
  }

  stats() {
    let active = 0;
    let revoked = 0;
    for (const id of this.identities.values()) {
      if (id.revoked) revoked++;
      else active++;
    }
    return { total: this.identities.size, active, revoked };
  }
}

module.exports = { Identity, Attestation, IdentityRegistry };
