/**
 * core/voting.js — Verifiable voting system
 *
 * Implements a commit–reveal voting scheme:
 *   1. COMMIT phase: voters submit hash(vote + nonce) — their choice is hidden
 *   2. REVEAL phase: voters reveal their vote and nonce — verified against commitment
 *   3. TALLY phase: all revealed votes are counted, Merkle root of ballots published
 *
 * Properties:
 *   - One person, one vote (enforced by identity fingerprint uniqueness)
 *   - Ballot secrecy during voting (commitments hide choices)
 *   - Full verifiability after reveal (anyone can re-tally from the ledger)
 *   - Tamper-evident (Merkle tree of all ballots included in ledger block)
 */

"use strict";

const crypto = require("./crypto");
const { LedgerEntry } = require("./ledger");
const { ProposalState } = require("./proposal");

// ---------------------------------------------------------------------------
// Ballot choices
// ---------------------------------------------------------------------------

const BallotChoice = {
  YEA: "YEA",
  NAY: "NAY",
  ABSTAIN: "ABSTAIN",
};

// ---------------------------------------------------------------------------
// Ballot
// ---------------------------------------------------------------------------

class Ballot {
  constructor({ voterFingerprint, proposalId, choice, nonce }) {
    this.id = crypto.generateId();
    this.voterFingerprint = voterFingerprint;
    this.proposalId = proposalId;
    this.choice = choice; // null during commit phase
    this.nonce = nonce; // null during commit phase
    this.commitment = null;
    this.revealed = false;
    this.timestamp = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Voting Session — manages a single vote on a single proposal
// ---------------------------------------------------------------------------

class VotingSession {
  /**
   * @param {Proposal} proposal
   * @param {Ledger}   ledger
   * @param {IdentityRegistry} identityRegistry
   */
  constructor(proposal, ledger, identityRegistry) {
    this.proposal = proposal;
    this.ledger = ledger;
    this.identityRegistry = identityRegistry;

    this.commitments = new Map(); // voterFingerprint -> commitment hash
    this.ballots = new Map(); // voterFingerprint -> Ballot
    this.phase = "COMMIT"; // COMMIT | REVEAL | TALLY | CLOSED
    this.tallyResult = null;
  }

  /**
   * Submit a commitment (hidden vote).
   * The voter computes hash(choice + nonce) locally and sends only the hash.
   */
  submitCommitment(voterFingerprint, commitmentHash, voterPrivateKey) {
    if (this.phase !== "COMMIT") {
      throw new Error("Not in commit phase");
    }

    const identity = this.identityRegistry.get(voterFingerprint);
    if (!identity || identity.revoked) {
      throw new Error("Voter is not registered or is revoked");
    }

    // Jurisdiction check
    const config = this.proposal.votingConfig;
    if (config && config.eligibleJurisdiction) {
      if (
        identity.jurisdiction !== config.eligibleJurisdiction &&
        config.eligibleJurisdiction !== "global"
      ) {
        throw new Error("Voter not in eligible jurisdiction");
      }
    }

    if (this.commitments.has(voterFingerprint)) {
      throw new Error("Voter already committed");
    }

    this.commitments.set(voterFingerprint, commitmentHash);

    // Record on ledger
    const entryData = {
      type: "VOTE_COMMIT",
      payload: {
        proposalId: this.proposal.id,
        commitment: commitmentHash,
      },
      actorId: voterFingerprint,
      timestamp: Date.now(),
    };
    entryData.signature = crypto.sign(
      crypto.stableStringify({
        type: entryData.type,
        payload: entryData.payload,
        actorId: entryData.actorId,
        timestamp: entryData.timestamp,
      }),
      voterPrivateKey,
    );
    this.ledger.addEntry(new LedgerEntry(entryData));

    return { success: true, commitmentHash };
  }

  /**
   * Start the reveal phase — no more commitments accepted.
   */
  startRevealPhase() {
    if (this.phase !== "COMMIT") {
      throw new Error("Not in commit phase");
    }
    this.phase = "REVEAL";
  }

  /**
   * Reveal a vote: provide the actual choice and nonce.
   * The system verifies hash(choice + nonce) === commitment.
   */
  revealVote(voterFingerprint, choice, nonce, voterPrivateKey) {
    if (this.phase !== "REVEAL") {
      throw new Error("Not in reveal phase");
    }
    if (!Object.values(BallotChoice).includes(choice)) {
      throw new Error(`Invalid choice: ${choice}`);
    }

    const commitment = this.commitments.get(voterFingerprint);
    if (!commitment) {
      throw new Error("No commitment found for this voter");
    }

    // Verify commitment
    if (!crypto.openCommitment(choice, nonce, commitment)) {
      throw new Error("Commitment verification failed — vote does not match");
    }

    const ballot = new Ballot({
      voterFingerprint,
      proposalId: this.proposal.id,
      choice,
      nonce,
    });
    ballot.commitment = commitment;
    ballot.revealed = true;
    this.ballots.set(voterFingerprint, ballot);

    // Record reveal on ledger
    const entryData = {
      type: "VOTE_REVEAL",
      payload: {
        proposalId: this.proposal.id,
        choice,
        nonce,
        ballotId: ballot.id,
      },
      actorId: voterFingerprint,
      timestamp: Date.now(),
    };
    entryData.signature = crypto.sign(
      crypto.stableStringify({
        type: entryData.type,
        payload: entryData.payload,
        actorId: entryData.actorId,
        timestamp: entryData.timestamp,
      }),
      voterPrivateKey,
    );
    this.ledger.addEntry(new LedgerEntry(entryData));

    return ballot;
  }

  /**
   * Tally all revealed votes. Produces a verifiable result.
   */
  tally() {
    if (this.phase !== "REVEAL") {
      throw new Error("Must be in reveal phase to tally");
    }
    this.phase = "TALLY";

    const counts = { YEA: 0, NAY: 0, ABSTAIN: 0 };
    const ballotHashes = [];

    for (const ballot of this.ballots.values()) {
      counts[ballot.choice]++;
      ballotHashes.push(
        crypto.hash({
          voter: ballot.voterFingerprint,
          choice: ballot.choice,
          nonce: ballot.nonce,
        }),
      );
    }

    // Build Merkle tree of all ballots for verifiability
    const ballotTree = new crypto.MerkleTree(ballotHashes);

    const totalCommitted = this.commitments.size;
    const totalRevealed = this.ballots.size;
    const unrevealed = totalCommitted - totalRevealed;

    const config = this.proposal.votingConfig || {};
    const eligibleVoters = config.eligibleJurisdiction
      ? this.identityRegistry.getByJurisdiction(
          config.eligibleJurisdiction,
        ).length
      : this.identityRegistry.stats().active;

    const quorumMet =
      (totalRevealed / Math.max(eligibleVoters, 1)) * 100 >=
      (config.quorumPercent || 0);

    const totalVotesExcludingAbstain = counts.YEA + counts.NAY;
    const passPercent =
      totalVotesExcludingAbstain > 0
        ? (counts.YEA / totalVotesExcludingAbstain) * 100
        : 0;
    const passed = quorumMet && passPercent > (config.passPercent || 50);

    this.tallyResult = {
      proposalId: this.proposal.id,
      counts,
      totalCommitted,
      totalRevealed,
      unrevealed,
      eligibleVoters,
      quorumMet,
      passPercent: Math.round(passPercent * 100) / 100,
      passed,
      ballotMerkleRoot: ballotTree.root,
      timestamp: Date.now(),
    };

    // Record tally on ledger
    const tallyEntry = new LedgerEntry({
      type: "VOTE_TALLY",
      payload: this.tallyResult,
      actorId: "SYSTEM",
      signature: crypto.hash(this.tallyResult), // system-signed with hash
      timestamp: Date.now(),
    });
    this.ledger.addEntry(tallyEntry);

    this.phase = "CLOSED";
    return this.tallyResult;
  }

  /**
   * Return the full record of this session for audit.
   */
  auditRecord() {
    return {
      proposalId: this.proposal.id,
      proposalTitle: this.proposal.title,
      phase: this.phase,
      totalCommitments: this.commitments.size,
      totalRevealed: this.ballots.size,
      ballots: [...this.ballots.values()].map((b) => ({
        ballotId: b.id,
        voter: b.voterFingerprint,
        choice: b.choice,
        commitment: b.commitment,
        nonceHash: crypto.hash(b.nonce), // don't leak nonce directly in audit
      })),
      tallyResult: this.tallyResult,
    };
  }
}

// ---------------------------------------------------------------------------
// Voting Manager — coordinates voting sessions
// ---------------------------------------------------------------------------

class VotingManager {
  constructor(ledger, identityRegistry, proposalRegistry) {
    this.ledger = ledger;
    this.identityRegistry = identityRegistry;
    this.proposalRegistry = proposalRegistry;
    this.sessions = new Map(); // proposalId -> VotingSession
  }

  /**
   * Open voting on a proposal.
   */
  openVoting(proposalId, actorFingerprint, actorPrivateKey) {
    const proposal = this.proposalRegistry.get(proposalId);
    if (!proposal) throw new Error("Proposal not found");

    if (proposal.state !== ProposalState.OPEN) {
      throw new Error(`Proposal must be OPEN to start voting, currently: ${proposal.state}`);
    }

    // Transition to VOTING
    this.proposalRegistry.transitionState(
      proposalId,
      ProposalState.VOTING,
      actorFingerprint,
      actorPrivateKey,
    );

    const session = new VotingSession(
      proposal,
      this.ledger,
      this.identityRegistry,
    );
    this.sessions.set(proposalId, session);
    return session;
  }

  getSession(proposalId) {
    return this.sessions.get(proposalId) || null;
  }

  /**
   * Finalise voting: reveal phase -> tally -> update proposal state.
   */
  finalise(proposalId, actorFingerprint, actorPrivateKey) {
    const session = this.sessions.get(proposalId);
    if (!session) throw new Error("No voting session for this proposal");

    if (session.phase === "COMMIT") {
      session.startRevealPhase();
    }

    const result = session.tally();

    const newState = result.passed
      ? ProposalState.ENACTED
      : ProposalState.REJECTED;

    // Transition through TALLYING then to final state
    this.proposalRegistry.transitionState(
      proposalId,
      ProposalState.TALLYING,
      actorFingerprint,
      actorPrivateKey,
    );
    this.proposalRegistry.transitionState(
      proposalId,
      newState,
      actorFingerprint,
      actorPrivateKey,
    );

    const proposal = this.proposalRegistry.get(proposalId);
    proposal.tallyResult = result;

    return result;
  }

  stats() {
    const byPhase = {};
    for (const s of this.sessions.values()) {
      byPhase[s.phase] = (byPhase[s.phase] || 0) + 1;
    }
    return { totalSessions: this.sessions.size, byPhase };
  }
}

module.exports = { BallotChoice, Ballot, VotingSession, VotingManager };
