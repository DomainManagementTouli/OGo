#!/usr/bin/env node

/**
 * OpenGov Test Suite — zero-dependency test runner
 *
 * Runs all core module tests and prints results.
 */

"use strict";

const crypto = require("../core/crypto");
const { Ledger, LedgerEntry } = require("../core/ledger");
const { IdentityRegistry } = require("../core/identity");
const { ProposalRegistry, ProposalState } = require("../core/proposal");
const { VotingManager, BallotChoice } = require("../core/voting");
const { PetitionManager, DEFAULT_SIGNATURE_THRESHOLD } = require("../core/petition");
const { AuditEngine } = require("../core/audit");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function section(name) {
  console.log(`\n▸ ${name}`);
}

// -------------------------------------------------------------------------
// Crypto
// -------------------------------------------------------------------------

section("Crypto — hashing");
assert(crypto.hash("hello") === crypto.hash("hello"), "Deterministic hash");
assert(crypto.hash("hello") !== crypto.hash("world"), "Different inputs -> different hashes");
assert(crypto.hash({ b: 2, a: 1 }) === crypto.hash({ a: 1, b: 2 }), "Stable stringify");

section("Crypto — key pairs & signatures");
const kp1 = crypto.generateKeyPair();
const kp2 = crypto.generateKeyPair();
assert(kp1.publicKey !== kp2.publicKey, "Unique key pairs");

const sig = crypto.sign("test message", kp1.privateKey);
assert(crypto.verify("test message", sig, kp1.publicKey), "Signature verifies");
assert(!crypto.verify("wrong message", sig, kp1.publicKey), "Wrong message fails");
assert(!crypto.verify("test message", sig, kp2.publicKey), "Wrong key fails");

section("Crypto — Merkle tree");
const leaves = ["a", "b", "c", "d"].map(crypto.hash);
const tree = new crypto.MerkleTree(leaves);
assert(tree.root.length === 64, "Root is 64-char hex");
const proof = tree.getProof(2);
assert(crypto.MerkleTree.verifyProof(leaves[2], proof, tree.root), "Proof verifies");
assert(!crypto.MerkleTree.verifyProof(leaves[0], proof, tree.root), "Wrong leaf fails proof");

section("Crypto — commitment scheme");
const { commitment, nonce } = crypto.createCommitment("YEA");
assert(crypto.openCommitment("YEA", nonce, commitment), "Commitment opens correctly");
assert(!crypto.openCommitment("NAY", nonce, commitment), "Wrong value fails");

section("Crypto — symmetric encryption");
const symKey = crypto.generateSymmetricKey();
const enc = crypto.symmetricEncrypt("secret ballot", symKey);
assert(crypto.symmetricDecrypt(enc, symKey) === "secret ballot", "Encrypt/decrypt roundtrip");

// -------------------------------------------------------------------------
// Ledger
// -------------------------------------------------------------------------

section("Ledger — basic operations");
const ledger = new Ledger(1);
assert(ledger.chain.length === 1, "Genesis block exists");
assert(ledger.verifyChain().valid, "Empty chain is valid");

const entry1 = new LedgerEntry({
  type: "TEST",
  payload: { msg: "hello" },
  actorId: "actor1",
  signature: "sig1",
});
ledger.addEntry(entry1);
const block = ledger.commitBlock();
assert(block !== null, "Block committed");
assert(ledger.chain.length === 2, "Chain grew");
assert(ledger.verifyChain().valid, "Chain still valid after block");

const retrieved = ledger.getEntry(entry1.id);
assert(retrieved !== null, "Entry retrievable by ID");
assert(retrieved.type === "TEST", "Entry type correct");

section("Ledger — inclusion proof");
const incProof = ledger.getInclusionProof(entry1.id);
assert(incProof !== null, "Proof exists");
assert(
  crypto.MerkleTree.verifyProof(incProof.leafHash, incProof.proof, incProof.merkleRoot),
  "Inclusion proof verifies",
);

section("Ledger — tamper detection");
const ledger2 = new Ledger(1);
ledger2.addEntry(new LedgerEntry({ type: "A", payload: {}, actorId: "x", signature: "s" }));
ledger2.commitBlock();
// Tamper with a block
ledger2.chain[1].entries[0].payload = { tampered: true };
assert(!ledger2.verifyChain().valid, "Tampering detected");

// -------------------------------------------------------------------------
// Identity
// -------------------------------------------------------------------------

section("Identity — registration & auth");
const idLedger = new Ledger(1);
const registry = new IdentityRegistry(idLedger);
const userKeys = crypto.generateKeyPair();
const result = registry.register({
  publicKey: userKeys.publicKey,
  alias: "alice",
  jurisdiction: "US",
  privateKey: userKeys.privateKey,
});
assert(result.identity.alias === "alice", "Registration works");
const fp = result.identity.fingerprint;
assert(registry.get(fp) !== null, "Lookup works");

const challenge = registry.issueChallenge(fp);
const challengeSig = crypto.sign(challenge, userKeys.privateKey);
assert(registry.verifyChallenge(fp, challengeSig), "Challenge-response auth works");

section("Identity — duplicate prevention");
let dupError = false;
try {
  registry.register({ publicKey: userKeys.publicKey, alias: "alice2", privateKey: userKeys.privateKey });
} catch (e) {
  dupError = true;
}
assert(dupError, "Duplicate registration rejected");

section("Identity — revocation");
registry.revoke(fp, userKeys.privateKey);
assert(registry.get(fp).revoked, "Identity revoked");

// -------------------------------------------------------------------------
// Full workflow: Proposal -> Petition -> Voting
// -------------------------------------------------------------------------

section("Full workflow — create proposal");
const wfLedger = new Ledger(1);
const wfRegistry = new IdentityRegistry(wfLedger);
const wfProposals = new ProposalRegistry(wfLedger, wfRegistry);
const wfVoting = new VotingManager(wfLedger, wfRegistry, wfProposals);
const wfPetitions = new PetitionManager(wfLedger, wfRegistry, wfProposals);

// Register author
const authorKeys = crypto.generateKeyPair();
const authorReg = wfRegistry.register({
  publicKey: authorKeys.publicKey,
  alias: "author",
  jurisdiction: "national",
  privateKey: authorKeys.privateKey,
});
const authorFp = authorReg.identity.fingerprint;
wfLedger.commitBlock();

// Create proposal
const proposal = wfProposals.create({
  type: "LAW",
  title: "Universal Data Privacy Act",
  fullText: "All citizens shall have the right to control their personal data...",
  summary: "Establishes data privacy rights",
  implications: [
    "Companies must obtain explicit consent before collecting data",
    "Citizens can request deletion of their data",
    "Violations carry fines up to 4% of annual revenue",
  ],
  jurisdiction: "national",
  authorFingerprint: authorFp,
  authorPrivateKey: authorKeys.privateKey,
});
wfLedger.commitBlock();
assert(proposal.state === ProposalState.DRAFT, "Proposal starts as DRAFT");
assert(proposal.implications.length === 3, "Implications recorded");

section("Full workflow — petition with threshold");
wfProposals.openForPetition(proposal.id, authorFp, authorKeys.privateKey);
wfLedger.commitBlock();
assert(proposal.state === ProposalState.PETITION, "State -> PETITION");

// Use threshold of 5 for testing
wfPetitions.createPetition(proposal.id, 5);

// Register 5 signers and sign
const signerKeys = [];
for (let i = 0; i < 5; i++) {
  const sk = crypto.generateKeyPair();
  const reg = wfRegistry.register({
    publicKey: sk.publicKey,
    alias: `signer${i}`,
    jurisdiction: "national",
    privateKey: sk.privateKey,
  });
  signerKeys.push({ keys: sk, fp: reg.identity.fingerprint });
}
wfLedger.commitBlock();

for (let i = 0; i < 5; i++) {
  const res = wfPetitions.sign(proposal.id, signerKeys[i].fp, signerKeys[i].keys.privateKey);
  if (i < 4) {
    assert(!res.petition.thresholdMet, `Signature ${i + 1}/5 — threshold not yet met`);
  } else {
    assert(res.petition.thresholdMet, "Threshold met at 5 signatures");
  }
}
wfLedger.commitBlock();
assert(proposal.state === ProposalState.OPEN, "Auto-transitioned to OPEN after threshold");

section("Full workflow — petition signature verification");
for (let i = 0; i < 5; i++) {
  const v = wfPetitions.verifySignature(proposal.id, signerKeys[i].fp);
  assert(v.valid, `Signer ${i} petition signature valid`);
}

section("Full workflow — voting (commit-reveal)");
proposal.setVotingConfig({ quorumPercent: 10, passPercent: 50 });
const session = wfVoting.openVoting(proposal.id, authorFp, authorKeys.privateKey);
wfLedger.commitBlock();
assert(proposal.state === ProposalState.VOTING, "State -> VOTING");

// Voters: author + 5 signers = 6 voters
const allVoters = [
  { fp: authorFp, keys: authorKeys },
  ...signerKeys.map((s) => ({ fp: s.fp, keys: s.keys })),
];

// Commit phase
const voterNonces = [];
for (let i = 0; i < allVoters.length; i++) {
  const choice = i < 4 ? "YEA" : "NAY";
  const nonce = crypto.generateNonce();
  voterNonces.push({ choice, nonce });
  const { commitment } = crypto.createCommitment(choice, nonce);
  session.submitCommitment(allVoters[i].fp, commitment, allVoters[i].keys.privateKey);
}
assert(session.commitments.size === 6, "All 6 commitments received");

// Reveal phase
session.startRevealPhase();
for (let i = 0; i < allVoters.length; i++) {
  session.revealVote(
    allVoters[i].fp,
    voterNonces[i].choice,
    voterNonces[i].nonce,
    allVoters[i].keys.privateKey,
  );
}
assert(session.ballots.size === 6, "All 6 reveals received");

section("Full workflow — tally");
const tally = session.tally();
assert(tally.counts.YEA === 4, "4 YEA votes");
assert(tally.counts.NAY === 2, "2 NAY votes");
assert(tally.passed === true, "Proposal passed (4/6 = 66.7% > 50%)");
assert(tally.ballotMerkleRoot.length === 64, "Ballot Merkle root computed");
wfLedger.commitBlock();

section("Full workflow — finalise proposal state");
// The session is already tallied; manually transition proposal
wfProposals.transitionState(proposal.id, ProposalState.TALLYING, authorFp, authorKeys.privateKey);
wfProposals.transitionState(proposal.id, ProposalState.ENACTED, authorFp, authorKeys.privateKey);
wfLedger.commitBlock();
assert(proposal.state === ProposalState.ENACTED, "Proposal ENACTED");

// -------------------------------------------------------------------------
// Audit
// -------------------------------------------------------------------------

section("Audit — chain integrity");
const audit = new AuditEngine(wfLedger, wfRegistry, wfProposals, wfVoting, wfPetitions);
const chainCheck = audit.verifyChainIntegrity();
assert(chainCheck.valid, "Entire chain is valid");

section("Audit — transparency report");
const report = audit.generateTransparencyReport();
assert(report.chain.valid, "Report confirms chain validity");
assert(report.identities.active > 0, "Report shows active identities");
assert(report.proposals.total > 0, "Report shows proposals");

section("Audit — proposal history");
const history = audit.getProposalHistory(proposal.id);
assert(history.length > 0, "Proposal has history entries");

section("Audit — vote re-tally from ledger");
const reTally = audit.verifyProposalVotes(proposal.id);
assert(reTally.tallyMatchesLedger, "Re-tally from ledger matches official tally");

// -------------------------------------------------------------------------
// Results
// -------------------------------------------------------------------------

console.log(`\n${"═".repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
