/**
 * core/proposal.js — Proposal system for laws, amendments, and referenda
 *
 * Citizens can create proposals that go through a defined lifecycle:
 *   DRAFT -> OPEN -> VOTING -> TALLYING -> ENACTED | REJECTED | EXPIRED
 *
 * Each proposal includes:
 *   - Full text of the proposed law or amendment
 *   - Impact analysis (implications that all voters must be informed of)
 *   - Jurisdiction (national / state)
 *   - Amendment references (if amending an existing law)
 *   - Version history (every edit is a new version, all recorded on ledger)
 */

"use strict";

const crypto = require("./crypto");
const { LedgerEntry } = require("./ledger");

// ---------------------------------------------------------------------------
// Proposal States
// ---------------------------------------------------------------------------

const ProposalState = {
  DRAFT: "DRAFT",
  PETITION: "PETITION",       // gathering signatures
  OPEN: "OPEN",               // open for discussion
  VOTING: "VOTING",           // voting period active
  TALLYING: "TALLYING",       // votes being tallied
  ENACTED: "ENACTED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  AMENDED: "AMENDED",         // superseded by amendment
};

const ProposalType = {
  LAW: "LAW",
  AMENDMENT: "AMENDMENT",
  REPEAL: "REPEAL",
  RESOLUTION: "RESOLUTION",
};

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

class Proposal {
  constructor({
    id,
    type,
    title,
    fullText,
    summary,
    implications,
    jurisdiction,
    amendmentOf,
    authorFingerprint,
    createdAt,
  }) {
    this.id = id || crypto.generateId();
    this.type = type || ProposalType.LAW;
    this.title = title;
    this.fullText = fullText;
    this.summary = summary || "";
    this.implications = implications || []; // array of strings — mandatory reading
    this.jurisdiction = jurisdiction || "national";
    this.amendmentOf = amendmentOf || null; // id of law being amended
    this.authorFingerprint = authorFingerprint;
    this.state = ProposalState.DRAFT;
    this.createdAt = createdAt || Date.now();
    this.versions = [
      {
        version: 1,
        fullText,
        summary,
        implications,
        timestamp: this.createdAt,
        hash: crypto.hash({ fullText, summary, implications }),
      },
    ];
    this.votingConfig = null;
    this.tallyResult = null;
  }

  currentVersion() {
    return this.versions[this.versions.length - 1];
  }

  /**
   * Create a new version (amendment to the proposal text before voting).
   * All versions are kept for transparency.
   */
  addVersion({ fullText, summary, implications, authorFingerprint }) {
    if (
      this.state !== ProposalState.DRAFT &&
      this.state !== ProposalState.OPEN
    ) {
      throw new Error(
        `Cannot edit proposal in state ${this.state}`,
      );
    }
    const version = {
      version: this.versions.length + 1,
      fullText: fullText || this.fullText,
      summary: summary || this.summary,
      implications: implications || this.implications,
      timestamp: Date.now(),
      editedBy: authorFingerprint,
      hash: crypto.hash({
        fullText: fullText || this.fullText,
        summary: summary || this.summary,
        implications: implications || this.implications,
      }),
    };
    this.versions.push(version);
    if (fullText) this.fullText = fullText;
    if (summary) this.summary = summary;
    if (implications) this.implications = implications;
    return version;
  }

  /**
   * Transition proposal state with validation.
   */
  transitionTo(newState) {
    const validTransitions = {
      [ProposalState.DRAFT]: [ProposalState.PETITION, ProposalState.OPEN],
      [ProposalState.PETITION]: [ProposalState.OPEN, ProposalState.EXPIRED],
      [ProposalState.OPEN]: [ProposalState.VOTING, ProposalState.EXPIRED],
      [ProposalState.VOTING]: [ProposalState.TALLYING],
      [ProposalState.TALLYING]: [
        ProposalState.ENACTED,
        ProposalState.REJECTED,
      ],
      [ProposalState.ENACTED]: [ProposalState.AMENDED],
    };

    const allowed = validTransitions[this.state];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(
        `Invalid transition: ${this.state} -> ${newState}`,
      );
    }
    this.state = newState;
    return this.state;
  }

  setVotingConfig(config) {
    this.votingConfig = {
      startTime: config.startTime || Date.now(),
      endTime: config.endTime || Date.now() + 7 * 24 * 60 * 60 * 1000,
      quorumPercent: config.quorumPercent || 10,
      passPercent: config.passPercent || 50,
      eligibleJurisdiction: config.eligibleJurisdiction || this.jurisdiction,
      ...config,
    };
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      title: this.title,
      fullText: this.fullText,
      summary: this.summary,
      implications: this.implications,
      jurisdiction: this.jurisdiction,
      amendmentOf: this.amendmentOf,
      authorFingerprint: this.authorFingerprint,
      state: this.state,
      createdAt: this.createdAt,
      versions: this.versions,
      votingConfig: this.votingConfig,
      tallyResult: this.tallyResult,
    };
  }

  static fromJSON(json) {
    const p = new Proposal(json);
    p.state = json.state;
    p.versions = json.versions;
    p.votingConfig = json.votingConfig;
    p.tallyResult = json.tallyResult;
    return p;
  }
}

// ---------------------------------------------------------------------------
// Proposal Registry
// ---------------------------------------------------------------------------

class ProposalRegistry {
  constructor(ledger, identityRegistry) {
    this.ledger = ledger;
    this.identityRegistry = identityRegistry;
    this.proposals = new Map(); // id -> Proposal
  }

  /**
   * Create a new proposal. Recorded on ledger.
   */
  create({
    type,
    title,
    fullText,
    summary,
    implications,
    jurisdiction,
    amendmentOf,
    authorFingerprint,
    authorPrivateKey,
  }) {
    const identity = this.identityRegistry.get(authorFingerprint);
    if (!identity) throw new Error("Author not registered");
    if (identity.revoked) throw new Error("Author identity is revoked");

    if (!implications || implications.length === 0) {
      throw new Error("Proposals must include at least one implication statement");
    }

    const proposal = new Proposal({
      type,
      title,
      fullText,
      summary,
      implications,
      jurisdiction,
      amendmentOf,
      authorFingerprint,
    });

    // Record on ledger
    const entryData = {
      type: "PROPOSAL_CREATE",
      payload: {
        proposalId: proposal.id,
        proposalType: proposal.type,
        title: proposal.title,
        textHash: proposal.currentVersion().hash,
        jurisdiction: proposal.jurisdiction,
        amendmentOf: proposal.amendmentOf,
      },
      actorId: authorFingerprint,
      timestamp: Date.now(),
    };
    entryData.signature = crypto.sign(
      crypto.stableStringify({
        type: entryData.type,
        payload: entryData.payload,
        actorId: entryData.actorId,
        timestamp: entryData.timestamp,
      }),
      authorPrivateKey,
    );

    const entry = new LedgerEntry(entryData);
    this.ledger.addEntry(entry);
    this.proposals.set(proposal.id, proposal);

    return proposal;
  }

  /**
   * Move a proposal to petition phase.
   */
  openForPetition(proposalId, actorFingerprint, actorPrivateKey) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error("Proposal not found");
    if (proposal.authorFingerprint !== actorFingerprint) {
      throw new Error("Only the author can advance the proposal");
    }

    proposal.transitionTo(ProposalState.PETITION);

    const entryData = {
      type: "PROPOSAL_STATE_CHANGE",
      payload: { proposalId, newState: ProposalState.PETITION },
      actorId: actorFingerprint,
      timestamp: Date.now(),
    };
    entryData.signature = crypto.sign(
      crypto.stableStringify({
        type: entryData.type,
        payload: entryData.payload,
        actorId: entryData.actorId,
        timestamp: entryData.timestamp,
      }),
      actorPrivateKey,
    );
    this.ledger.addEntry(new LedgerEntry(entryData));

    return proposal;
  }

  /**
   * Transition proposal to any valid next state.
   */
  transitionState(proposalId, newState, actorFingerprint, actorPrivateKey) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error("Proposal not found");

    proposal.transitionTo(newState);

    const entryData = {
      type: "PROPOSAL_STATE_CHANGE",
      payload: { proposalId, newState },
      actorId: actorFingerprint,
      timestamp: Date.now(),
    };
    entryData.signature = crypto.sign(
      crypto.stableStringify({
        type: entryData.type,
        payload: entryData.payload,
        actorId: entryData.actorId,
        timestamp: entryData.timestamp,
      }),
      actorPrivateKey,
    );
    this.ledger.addEntry(new LedgerEntry(entryData));

    return proposal;
  }

  get(proposalId) {
    return this.proposals.get(proposalId) || null;
  }

  getByState(state) {
    return [...this.proposals.values()].filter((p) => p.state === state);
  }

  getByJurisdiction(jurisdiction) {
    return [...this.proposals.values()].filter(
      (p) => p.jurisdiction === jurisdiction,
    );
  }

  getAll() {
    return [...this.proposals.values()];
  }

  stats() {
    const byState = {};
    for (const p of this.proposals.values()) {
      byState[p.state] = (byState[p.state] || 0) + 1;
    }
    return { total: this.proposals.size, byState };
  }
}

module.exports = { ProposalState, ProposalType, Proposal, ProposalRegistry };
