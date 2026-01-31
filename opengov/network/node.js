/**
 * network/node.js — Peer-to-peer node for decentralized ledger replication
 *
 * Each node maintains a full copy of the ledger and synchronises with peers.
 * New blocks are broadcast to all connected peers. Nodes validate incoming
 * blocks before appending them.
 *
 * Uses a simple TCP-based protocol (JSON over newline-delimited streams).
 * In production this would use libp2p or similar, but this implementation
 * demonstrates the architecture with zero external dependencies.
 */

"use strict";

const net = require("net");
const { Ledger, Block, LedgerEntry } = require("../core/ledger");
const crypto = require("../core/crypto");

const MSG_TYPES = {
  HANDSHAKE: "HANDSHAKE",
  REQUEST_CHAIN: "REQUEST_CHAIN",
  CHAIN_RESPONSE: "CHAIN_RESPONSE",
  NEW_BLOCK: "NEW_BLOCK",
  NEW_ENTRY: "NEW_ENTRY",
  PEER_LIST: "PEER_LIST",
  REQUEST_PEERS: "REQUEST_PEERS",
};

class PeerNode {
  /**
   * @param {object} opts
   * @param {number} opts.port
   * @param {string} opts.host
   * @param {string} opts.nodeId
   * @param {Ledger} opts.ledger
   */
  constructor(opts = {}) {
    this.port = opts.port || 0;
    this.host = opts.host || "0.0.0.0";
    this.nodeId = opts.nodeId || crypto.generateId();
    this.ledger = opts.ledger || new Ledger();
    this.peers = new Map(); // nodeId -> socket
    this.knownPeers = new Set(); // "host:port" strings
    this.server = null;
    this.listeners = new Map(); // event -> [callbacks]
    this.running = false;
  }

  /**
   * Start listening for incoming peer connections.
   */
  start() {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => this._handleConnection(socket));
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        this.running = true;
        this._emit("started", { port: this.port, nodeId: this.nodeId });
        resolve(this.port);
      });
    });
  }

  /**
   * Connect to a peer node.
   */
  connectToPeer(host, port) {
    return new Promise((resolve, reject) => {
      const key = `${host}:${port}`;
      if (this.knownPeers.has(key)) return resolve(false);

      const socket = net.createConnection({ host, port }, () => {
        this.knownPeers.add(key);
        this._send(socket, {
          type: MSG_TYPES.HANDSHAKE,
          nodeId: this.nodeId,
          port: this.port,
        });
        resolve(true);
      });

      socket.on("error", (err) => {
        this._emit("peer_error", { host, port, error: err.message });
        reject(err);
      });

      this._setupSocket(socket);
    });
  }

  /**
   * Broadcast a new entry to all peers.
   */
  broadcastEntry(entry) {
    this._broadcast({
      type: MSG_TYPES.NEW_ENTRY,
      entry: entry.toJSON ? entry.toJSON() : entry,
    });
  }

  /**
   * Broadcast a new block to all peers.
   */
  broadcastBlock(block) {
    this._broadcast({
      type: MSG_TYPES.NEW_BLOCK,
      block: block.toJSON ? block.toJSON() : block,
    });
  }

  /**
   * Request the full chain from a peer (for initial sync).
   */
  requestChain(peerNodeId) {
    const socket = this.peers.get(peerNodeId);
    if (!socket) throw new Error(`Not connected to peer: ${peerNodeId}`);
    this._send(socket, { type: MSG_TYPES.REQUEST_CHAIN });
  }

  /**
   * Stop the node.
   */
  stop() {
    return new Promise((resolve) => {
      this.running = false;
      for (const socket of this.peers.values()) {
        socket.destroy();
      }
      this.peers.clear();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Register an event listener.
   */
  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  // -----------------------------------------------------------------------
  // Internal methods
  // -----------------------------------------------------------------------

  _handleConnection(socket) {
    this._setupSocket(socket);
  }

  _setupSocket(socket) {
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            this._handleMessage(msg, socket);
          } catch (_) {
            // ignore malformed messages
          }
        }
      }
    });

    socket.on("close", () => {
      // Remove from peers
      for (const [id, s] of this.peers) {
        if (s === socket) {
          this.peers.delete(id);
          this._emit("peer_disconnected", { nodeId: id });
          break;
        }
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }

  _handleMessage(msg, socket) {
    switch (msg.type) {
      case MSG_TYPES.HANDSHAKE:
        this.peers.set(msg.nodeId, socket);
        this._emit("peer_connected", { nodeId: msg.nodeId });
        // Send our handshake back
        this._send(socket, {
          type: MSG_TYPES.HANDSHAKE,
          nodeId: this.nodeId,
          port: this.port,
        });
        break;

      case MSG_TYPES.REQUEST_CHAIN:
        this._send(socket, {
          type: MSG_TYPES.CHAIN_RESPONSE,
          chain: this.ledger.toJSON(),
        });
        break;

      case MSG_TYPES.CHAIN_RESPONSE:
        this._handleChainResponse(msg.chain);
        break;

      case MSG_TYPES.NEW_BLOCK:
        this._handleNewBlock(msg.block);
        break;

      case MSG_TYPES.NEW_ENTRY:
        this._handleNewEntry(msg.entry);
        break;

      case MSG_TYPES.REQUEST_PEERS:
        this._send(socket, {
          type: MSG_TYPES.PEER_LIST,
          peers: [...this.knownPeers],
        });
        break;

      case MSG_TYPES.PEER_LIST:
        for (const peer of msg.peers || []) {
          this.knownPeers.add(peer);
        }
        break;
    }
  }

  _handleChainResponse(chainJson) {
    try {
      const receivedLedger = Ledger.fromJSON(chainJson);
      const verification = receivedLedger.verifyChain();
      if (
        verification.valid &&
        receivedLedger.chain.length > this.ledger.chain.length
      ) {
        this.ledger = receivedLedger;
        this._emit("chain_synced", {
          blocks: receivedLedger.chain.length,
        });
      }
    } catch (e) {
      this._emit("sync_error", { error: e.message });
    }
  }

  _handleNewBlock(blockJson) {
    try {
      const block = Block.fromJSON(blockJson);
      // Verify it chains to our latest
      if (block.previousHash === this.ledger.latestBlock().hash) {
        this.ledger.chain.push(block);
        // Rebuild indexes for the new block
        const bi = this.ledger.chain.length - 1;
        for (let ei = 0; ei < block.entries.length; ei++) {
          const entry = block.entries[ei];
          this.ledger.entryIndex.set(entry.id, { blockIdx: bi, entryIdx: ei });
          if (!this.ledger.typeIndex.has(entry.type))
            this.ledger.typeIndex.set(entry.type, new Set());
          this.ledger.typeIndex.get(entry.type).add(entry.id);
          if (!this.ledger.actorIndex.has(entry.actorId))
            this.ledger.actorIndex.set(entry.actorId, new Set());
          this.ledger.actorIndex.get(entry.actorId).add(entry.id);
        }
        this._emit("new_block", { index: block.index });
      }
    } catch (e) {
      this._emit("block_error", { error: e.message });
    }
  }

  _handleNewEntry(entryJson) {
    try {
      const entry = LedgerEntry.fromJSON(entryJson);
      this.ledger.addEntry(entry);
      this._emit("new_entry", { id: entry.id, type: entry.type });
    } catch (e) {
      this._emit("entry_error", { error: e.message });
    }
  }

  _send(socket, msg) {
    try {
      socket.write(JSON.stringify(msg) + "\n");
    } catch (_) {
      // socket may be closed
    }
  }

  _broadcast(msg) {
    for (const socket of this.peers.values()) {
      this._send(socket, msg);
    }
  }

  _emit(event, data) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) cb(data);
    }
  }

  stats() {
    return {
      nodeId: this.nodeId,
      port: this.port,
      running: this.running,
      connectedPeers: this.peers.size,
      knownPeers: this.knownPeers.size,
      ledger: this.ledger.stats(),
    };
  }
}

module.exports = { PeerNode, MSG_TYPES };
