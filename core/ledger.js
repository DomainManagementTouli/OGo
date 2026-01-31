/**
 * core/ledger.js — Immutable append-only ledger (blockchain-like)
 *
 * Every action in the system (registration, proposal creation, vote, signature,
 * amendment) is recorded as an entry in this ledger. Entries are grouped into
 * blocks, each containing a Merkle root of its entries and a hash pointer to
 * the previous block.
 *
 * The ledger is the single source of truth; any node can independently verify
 * the entire chain from genesis.
 */

"use strict";

const crypto = require("./crypto");

// ---------------------------------------------------------------------------
// Ledger Entry
// ---------------------------------------------------------------------------

class LedgerEntry {
  /**
   * @param {string}  type      — entry type (e.g. "REGISTER", "PROPOSAL", "VOTE", "SIGNATURE")
   * @param {object}  payload   — the action-specific data
   * @param {string}  actorId   — fingerprint of the actor's public key
   * @param {string}  signature — hex signature over (type + payload + actorId + timestamp)
   */
  constructor({ type, payload, actorId, signature, timestamp }) {
    this.id = crypto.generateId();
    this.type = type;
    this.payload = payload;
    this.actorId = actorId;
    this.signature = signature;
    this.timestamp = timestamp || Date.now();
    this.hash = this._computeHash();
  }

  _computeHash() {
    return crypto.hash({
      id: this.id,
      type: this.type,
      payload: this.payload,
      actorId: this.actorId,
      timestamp: this.timestamp,
    });
  }

  /**
   * Return the canonical signable content for this entry.
   */
  signableContent() {
    return crypto.stableStringify({
      type: this.type,
      payload: this.payload,
      actorId: this.actorId,
      timestamp: this.timestamp,
    });
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      payload: this.payload,
      actorId: this.actorId,
      signature: this.signature,
      timestamp: this.timestamp,
      hash: this.hash,
    };
  }

  static fromJSON(json) {
    const entry = new LedgerEntry({
      type: json.type,
      payload: json.payload,
      actorId: json.actorId,
      signature: json.signature,
      timestamp: json.timestamp,
    });
    entry.id = json.id;
    entry.hash = json.hash;
    return entry;
  }
}

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

class Block {
  /**
   * @param {number}        index
   * @param {LedgerEntry[]} entries
   * @param {string}        previousHash
   */
  constructor(index, entries, previousHash) {
    this.index = index;
    this.timestamp = Date.now();
    this.entries = entries;
    this.previousHash = previousHash;
    this.merkleRoot = this._computeMerkleRoot();
    this.nonce = 0; // for optional proof-of-work style finality
    this.hash = this._computeHash();
  }

  _computeMerkleRoot() {
    if (this.entries.length === 0) return crypto.hash("");
    const leaves = this.entries.map((e) => e.hash);
    const tree = new crypto.MerkleTree(leaves);
    return tree.root;
  }

  _computeHash() {
    return crypto.hash({
      index: this.index,
      timestamp: this.timestamp,
      merkleRoot: this.merkleRoot,
      previousHash: this.previousHash,
      nonce: this.nonce,
    });
  }

  /**
   * Simple proof-of-work (adjustable difficulty) — optional, used to
   * throttle block production and make tampering expensive.
   */
  mine(difficulty = 2) {
    const prefix = "0".repeat(difficulty);
    while (!this.hash.startsWith(prefix)) {
      this.nonce++;
      this.hash = this._computeHash();
    }
    return this;
  }

  toJSON() {
    return {
      index: this.index,
      timestamp: this.timestamp,
      entries: this.entries.map((e) => e.toJSON()),
      previousHash: this.previousHash,
      merkleRoot: this.merkleRoot,
      nonce: this.nonce,
      hash: this.hash,
    };
  }

  static fromJSON(json) {
    const entries = json.entries.map((e) => LedgerEntry.fromJSON(e));
    const block = new Block(json.index, entries, json.previousHash);
    block.timestamp = json.timestamp;
    block.nonce = json.nonce;
    block.merkleRoot = json.merkleRoot;
    block.hash = json.hash;
    return block;
  }
}

// ---------------------------------------------------------------------------
// Ledger (Chain)
// ---------------------------------------------------------------------------

class Ledger {
  constructor(difficulty = 2) {
    this.difficulty = difficulty;
    this.chain = [this._createGenesisBlock()];
    this.pendingEntries = [];
    this.entryIndex = new Map(); // id -> { blockIdx, entryIdx }
    this.typeIndex = new Map(); // type -> Set<entryId>
    this.actorIndex = new Map(); // actorId -> Set<entryId>
  }

  _createGenesisBlock() {
    const genesis = new Block(0, [], "0");
    genesis.mine(this.difficulty);
    return genesis;
  }

  latestBlock() {
    return this.chain[this.chain.length - 1];
  }

  /**
   * Add a signed entry to the pending pool.
   */
  addEntry(entry) {
    this.pendingEntries.push(entry);
    return entry;
  }

  /**
   * Seal pending entries into a new block and append to chain.
   */
  commitBlock() {
    if (this.pendingEntries.length === 0) return null;

    const block = new Block(
      this.chain.length,
      [...this.pendingEntries],
      this.latestBlock().hash,
    );
    block.mine(this.difficulty);
    this.chain.push(block);

    // Update indexes
    const blockIdx = this.chain.length - 1;
    for (let i = 0; i < block.entries.length; i++) {
      const entry = block.entries[i];
      this.entryIndex.set(entry.id, { blockIdx, entryIdx: i });

      if (!this.typeIndex.has(entry.type))
        this.typeIndex.set(entry.type, new Set());
      this.typeIndex.get(entry.type).add(entry.id);

      if (!this.actorIndex.has(entry.actorId))
        this.actorIndex.set(entry.actorId, new Set());
      this.actorIndex.get(entry.actorId).add(entry.id);
    }

    this.pendingEntries = [];
    return block;
  }

  /**
   * Verify the integrity of the entire chain.
   */
  verifyChain() {
    for (let i = 1; i < this.chain.length; i++) {
      const current = this.chain[i];
      const previous = this.chain[i - 1];

      // Check hash pointer
      if (current.previousHash !== previous.hash) {
        return {
          valid: false,
          error: `Block ${i} previousHash mismatch`,
          blockIndex: i,
        };
      }

      // Re-compute hash
      const recalc = crypto.hash({
        index: current.index,
        timestamp: current.timestamp,
        merkleRoot: current.merkleRoot,
        previousHash: current.previousHash,
        nonce: current.nonce,
      });
      if (recalc !== current.hash) {
        return {
          valid: false,
          error: `Block ${i} hash mismatch`,
          blockIndex: i,
        };
      }

      // Verify each entry's hash matches its content
      for (let j = 0; j < current.entries.length; j++) {
        const entry = current.entries[j];
        const recomputedEntryHash = crypto.hash({
          id: entry.id,
          type: entry.type,
          payload: entry.payload,
          actorId: entry.actorId,
          timestamp: entry.timestamp,
        });
        if (recomputedEntryHash !== entry.hash) {
          return {
            valid: false,
            error: `Block ${i} entry ${j} hash mismatch (data tampered)`,
            blockIndex: i,
          };
        }
      }

      // Verify Merkle root
      if (current.entries.length > 0) {
        const leaves = current.entries.map((e) => e.hash);
        const tree = new crypto.MerkleTree(leaves);
        if (tree.root !== current.merkleRoot) {
          return {
            valid: false,
            error: `Block ${i} Merkle root mismatch`,
            blockIndex: i,
          };
        }
      }
    }
    return { valid: true };
  }

  /**
   * Retrieve an entry by ID.
   */
  getEntry(id) {
    const loc = this.entryIndex.get(id);
    if (!loc) return null;
    return this.chain[loc.blockIdx].entries[loc.entryIdx];
  }

  /**
   * Retrieve all entries of a given type.
   */
  getEntriesByType(type) {
    const ids = this.typeIndex.get(type);
    if (!ids) return [];
    return [...ids].map((id) => this.getEntry(id));
  }

  /**
   * Retrieve all entries by a given actor.
   */
  getEntriesByActor(actorId) {
    const ids = this.actorIndex.get(actorId);
    if (!ids) return [];
    return [...ids].map((id) => this.getEntry(id));
  }

  /**
   * Get a Merkle inclusion proof for an entry.
   */
  getInclusionProof(entryId) {
    const loc = this.entryIndex.get(entryId);
    if (!loc) return null;
    const block = this.chain[loc.blockIdx];
    const leaves = block.entries.map((e) => e.hash);
    const tree = new crypto.MerkleTree(leaves);
    return {
      blockIndex: loc.blockIdx,
      entryIndex: loc.entryIdx,
      merkleRoot: block.merkleRoot,
      proof: tree.getProof(loc.entryIdx),
      leafHash: block.entries[loc.entryIdx].hash,
    };
  }

  /**
   * Export entire ledger to JSON.
   */
  toJSON() {
    return {
      difficulty: this.difficulty,
      chain: this.chain.map((b) => b.toJSON()),
    };
  }

  /**
   * Import ledger from JSON and rebuild indexes.
   */
  static fromJSON(json) {
    const ledger = new Ledger(json.difficulty);
    ledger.chain = json.chain.map((b) => Block.fromJSON(b));
    // Rebuild indexes
    for (let bi = 1; bi < ledger.chain.length; bi++) {
      const block = ledger.chain[bi];
      for (let ei = 0; ei < block.entries.length; ei++) {
        const entry = block.entries[ei];
        ledger.entryIndex.set(entry.id, { blockIdx: bi, entryIdx: ei });
        if (!ledger.typeIndex.has(entry.type))
          ledger.typeIndex.set(entry.type, new Set());
        ledger.typeIndex.get(entry.type).add(entry.id);
        if (!ledger.actorIndex.has(entry.actorId))
          ledger.actorIndex.set(entry.actorId, new Set());
        ledger.actorIndex.get(entry.actorId).add(entry.id);
      }
    }
    return ledger;
  }

  /**
   * Get full chain statistics.
   */
  stats() {
    let totalEntries = 0;
    for (const block of this.chain) totalEntries += block.entries.length;
    return {
      blocks: this.chain.length,
      totalEntries,
      pendingEntries: this.pendingEntries.length,
      latestBlockHash: this.latestBlock().hash,
      chainValid: this.verifyChain().valid,
    };
  }
}

module.exports = { LedgerEntry, Block, Ledger };
