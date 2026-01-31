#!/usr/bin/env node

/**
 * OpenGov — Decentralized Governance System
 *
 * Entry point. Supports two modes:
 *   --mode web    Start the HTTP dashboard + API server (default)
 *   --mode node   Start a P2P node that replicates the ledger
 *
 * Options:
 *   --port <n>    Port to listen on (default: 3000 for web, 4000 for node)
 *   --peer <host:port>  Connect to a peer node on startup
 */

"use strict";

const { GovernanceServer } = require("./web/server");
const { PeerNode } = require("./network/node");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mode: "web", port: null, peers: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode" && args[i + 1]) opts.mode = args[++i];
    if (args[i] === "--port" && args[i + 1]) opts.port = parseInt(args[++i], 10);
    if (args[i] === "--peer" && args[i + 1]) opts.peers.push(args[++i]);
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  if (opts.mode === "web") {
    const port = opts.port || 3000;
    const server = new GovernanceServer({ port });
    await server.start();
    console.log(`
╔══════════════════════════════════════════════════════╗
║           OpenGov — Decentralized Governance         ║
╠══════════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${port}                   ║
║  API:        http://localhost:${port}/api                ║
║                                                      ║
║  All actions are recorded on an immutable ledger.    ║
║  All data is publicly verifiable. Zero trust needed. ║
╚══════════════════════════════════════════════════════╝
`);
  } else if (opts.mode === "node") {
    const port = opts.port || 4000;
    const node = new PeerNode({ port });
    await node.start();
    console.log(`[OpenGov Node] Started on port ${port} — ID: ${node.nodeId}`);

    for (const peer of opts.peers) {
      const [host, peerPort] = peer.split(":");
      try {
        await node.connectToPeer(host, parseInt(peerPort, 10));
        console.log(`[OpenGov Node] Connected to peer ${peer}`);
      } catch (e) {
        console.error(`[OpenGov Node] Failed to connect to ${peer}: ${e.message}`);
      }
    }

    node.on("peer_connected", (d) => console.log(`[Peer] Connected: ${d.nodeId}`));
    node.on("new_block", (d) => console.log(`[Block] New block #${d.index}`));
    node.on("chain_synced", (d) => console.log(`[Sync] Chain synced: ${d.blocks} blocks`));
  } else {
    console.error(`Unknown mode: ${opts.mode}. Use --mode web or --mode node`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
