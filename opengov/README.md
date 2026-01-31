# OpenGov — Decentralized Transparent Governance System

An open-source system for decentralized democratic participation: voting on laws, amendments, and citizen petitions with cryptographic verification, an immutable audit ledger, and zero reliance on human intermediaries.

**Zero external dependencies.** Built entirely on Node.js built-in modules.

## Architecture

```
opengov/
├── core/
│   ├── crypto.js       # SHA-3 hashing, Ed25519 signatures, Merkle trees, commitments
│   ├── ledger.js       # Immutable append-only blockchain (entries, blocks, chain verification)
│   ├── identity.js     # Decentralized identity registry, challenge-response auth, attestations
│   ├── proposal.js     # Law/amendment/repeal proposals with version history & implications
│   ├── voting.js       # Commit-reveal voting with ballot Merkle proofs
│   ├── petition.js     # Petition signatures (300 threshold) with implication acknowledgement
│   └── audit.js        # Full transparency: chain verification, re-tally, entry proofs
├── network/
│   └── node.js         # TCP peer-to-peer node for ledger replication
├── web/
│   ├── server.js       # HTTP REST API + static file server
│   └── public/         # Dashboard UI (HTML/CSS/JS)
├── test/
│   └── run.js          # 56-test suite covering all modules
└── index.js            # CLI entry point
```

## Core Concepts

### Immutable Ledger
Every action (registration, proposal, vote, petition signature) is recorded as a signed entry in an append-only blockchain. Blocks contain Merkle roots of their entries and hash pointers to the previous block. Any node can independently verify the entire chain.

### Decentralized Identity
Citizens generate Ed25519 key pairs locally. The public key fingerprint is the identity. Authentication uses challenge-response (sign a random nonce). No central authority holds credentials. Optional third-party attestations (e.g. "unique human") can be added.

### Proposals
Citizens create proposals (laws, amendments, repeals) that follow a lifecycle:
```
DRAFT → PETITION → OPEN → VOTING → TALLYING → ENACTED / REJECTED
```
Every proposal must include **implications** — statements that voters must acknowledge before participating.

### Petition System
Before a proposal goes to vote, it must collect **300 signatures** from authenticated users. Each signer cryptographically proves they had access to and read all implications before signing. Once the threshold is met, the proposal auto-transitions to OPEN.

### Commit-Reveal Voting
1. **Commit phase**: Voters submit `hash(choice + nonce)` — their vote is hidden
2. **Reveal phase**: Voters reveal their choice and nonce — verified against the commitment
3. **Tally**: All revealed votes are counted. A Merkle root of all ballots is published on the ledger.

Properties: one-person-one-vote, ballot secrecy during voting, full verifiability after reveal.

### Transparency & Audit
- Full chain integrity verification
- Merkle inclusion proofs for any entry
- Signature verification for any entry
- Independent re-tallying of any vote from ledger data
- Complete activity history for any identity or proposal
- Exportable ledger for external verification

## Quick Start

```bash
# Run tests (56 tests, all modules)
node opengov/test/run.js

# Start the web dashboard
node opengov/index.js --mode web --port 3000

# Start a P2P node
node opengov/index.js --mode node --port 4000

# Connect to a peer
node opengov/index.js --mode node --port 4001 --peer localhost:4000
```

## API Endpoints

### Identity
- `POST /api/identity/generate-keypair` — Generate Ed25519 key pair
- `POST /api/identity/register` — Register identity on ledger
- `POST /api/identity/challenge` — Get auth challenge nonce
- `POST /api/identity/verify` — Verify challenge response
- `GET  /api/identity/list` — List registered identities

### Proposals
- `POST /api/proposal/create` — Create a proposal (must include implications)
- `GET  /api/proposal/list` — List proposals (optional `?state=` filter)
- `GET  /api/proposal/:id` — Get proposal details
- `POST /api/proposal/open-petition` — Move to petition phase

### Petitions
- `POST /api/petition/sign` — Sign a petition (requires reading implications)
- `GET  /api/petition/:proposalId` — Get petition status

### Voting
- `POST /api/voting/open` — Open voting on a proposal
- `POST /api/voting/commit` — Submit vote commitment
- `POST /api/voting/reveal` — Reveal vote
- `POST /api/voting/finalise` — Tally and finalise

### Audit
- `GET /api/audit/chain` — Verify chain integrity
- `GET /api/audit/report` — Full transparency report
- `GET /api/audit/ledger` — Export entire ledger as JSON
- `GET /api/audit/entry/:id` — Verify entry inclusion + signature
- `GET /api/audit/proposal/:id` — Full proposal history
- `GET /api/audit/identity/:id` — Identity activity log

## Design Principles

1. **Zero trust**: No component requires trust in any authority. All data is publicly verifiable.
2. **Transparency by default**: Every action is recorded, signed, and Merkle-proofed.
3. **No human intermediaries**: The system enforces rules algorithmically.
4. **Privacy-preserving**: Commit-reveal hides votes during voting. Pseudonymous identities.
5. **Tamper-evident**: Any modification to historical data is cryptographically detectable.
6. **Zero dependencies**: Only Node.js built-in modules. No supply chain risk.

## License

GPL-3.0
