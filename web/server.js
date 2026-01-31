/**
 * web/server.js — HTTP API & web dashboard server
 *
 * Provides a REST API for interacting with the governance system and serves
 * the public dashboard. No external dependencies — uses Node.js built-in http.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const { Ledger } = require("../core/ledger");
const { IdentityRegistry } = require("../core/identity");
const { ProposalRegistry, ProposalState } = require("../core/proposal");
const { VotingManager, BallotChoice } = require("../core/voting");
const { PetitionManager } = require("../core/petition");
const { AuditEngine } = require("../core/audit");
const cryptoUtil = require("../core/crypto");

class GovernanceServer {
  constructor(opts = {}) {
    this.port = opts.port || 3000;
    this.host = opts.host || "0.0.0.0";

    // Initialise core systems
    this.ledger = opts.ledger || new Ledger(2);
    this.identityRegistry = new IdentityRegistry(this.ledger);
    this.proposalRegistry = new ProposalRegistry(this.ledger, this.identityRegistry);
    this.votingManager = new VotingManager(this.ledger, this.identityRegistry, this.proposalRegistry);
    this.petitionManager = new PetitionManager(this.ledger, this.identityRegistry, this.proposalRegistry);
    this.audit = new AuditEngine(
      this.ledger,
      this.identityRegistry,
      this.proposalRegistry,
      this.votingManager,
      this.petitionManager,
    );

    // Biometric credential store: fingerprint -> { credentialId, publicKey, counter, enrolledAt }
    this.biometricCredentials = new Map();
    // Active biometric challenges: challengeId -> { fingerprint, challenge, expiresAt }
    this.biometricChallenges = new Map();

    this.server = null;
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));
      this.server.listen(this.port, this.host, () => {
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  async _handleRequest(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const method = req.method;

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      // Static files
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return this._serveFile(res, "public/index.html", "text/html");
      }
      if (method === "GET" && pathname.startsWith("/css/")) {
        return this._serveFile(res, "public" + pathname, "text/css");
      }
      if (method === "GET" && pathname.startsWith("/js/")) {
        return this._serveFile(res, "public" + pathname, "application/javascript");
      }
      if (method === "GET" && pathname.startsWith("/img/")) {
        const ext = pathname.split(".").pop();
        const types = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", ico: "image/x-icon" };
        return this._serveFile(res, "public" + pathname, types[ext] || "application/octet-stream");
      }

      // API routes
      if (pathname.startsWith("/api/")) {
        const body = method === "POST" ? await this._readBody(req) : null;
        return this._handleApi(pathname, method, parsed.query, body, res);
      }

      this._json(res, 404, { error: "Not found" });
    } catch (err) {
      this._json(res, 500, { error: err.message });
    }
  }

  _handleApi(pathname, method, query, body, res) {
    try {
      // --- Identity ---
      if (pathname === "/api/identity/generate-keypair" && method === "POST") {
        const kp = cryptoUtil.generateKeyPair();
        const fp = cryptoUtil.fingerprintPublicKey(kp.publicKey);
        return this._json(res, 200, { fingerprint: fp, ...kp });
      }
      if (pathname === "/api/identity/register" && method === "POST") {
        const result = this.identityRegistry.register(body);
        this.ledger.commitBlock();
        return this._json(res, 201, { fingerprint: result.identity.fingerprint, entryId: result.entryId });
      }
      if (pathname === "/api/identity/challenge" && method === "POST") {
        const nonce = this.identityRegistry.issueChallenge(body.fingerprint);
        return this._json(res, 200, { nonce });
      }
      if (pathname === "/api/identity/verify" && method === "POST") {
        const valid = this.identityRegistry.verifyChallenge(body.fingerprint, body.signedNonce);
        return this._json(res, 200, { valid });
      }
      if (pathname === "/api/identity/list" && method === "GET") {
        const identities = [];
        for (const id of this.identityRegistry.identities.values()) {
          if (!id.revoked) identities.push(id.toJSON());
        }
        return this._json(res, 200, { identities });
      }

      // --- Proposals ---
      if (pathname === "/api/proposal/create" && method === "POST") {
        const proposal = this.proposalRegistry.create(body);
        this.ledger.commitBlock();
        return this._json(res, 201, proposal.toJSON());
      }
      if (pathname === "/api/proposal/list" && method === "GET") {
        const state = query.state;
        const proposals = state
          ? this.proposalRegistry.getByState(state)
          : this.proposalRegistry.getAll();
        return this._json(res, 200, { proposals: proposals.map((p) => p.toJSON()) });
      }
      if (pathname.match(/^\/api\/proposal\/[a-f0-9]+$/) && method === "GET") {
        const id = pathname.split("/").pop();
        const proposal = this.proposalRegistry.get(id);
        if (!proposal) return this._json(res, 404, { error: "Not found" });
        return this._json(res, 200, proposal.toJSON());
      }
      if (pathname === "/api/proposal/open-petition" && method === "POST") {
        const proposal = this.proposalRegistry.openForPetition(
          body.proposalId, body.authorFingerprint, body.authorPrivateKey,
        );
        this.petitionManager.createPetition(body.proposalId, body.threshold);
        this.ledger.commitBlock();
        return this._json(res, 200, proposal.toJSON());
      }

      // --- Petitions ---
      if (pathname === "/api/petition/sign" && method === "POST") {
        const result = this.petitionManager.sign(
          body.proposalId, body.signerFingerprint, body.signerPrivateKey,
        );
        this.ledger.commitBlock();
        return this._json(res, 200, result);
      }
      if (pathname.match(/^\/api\/petition\/[a-f0-9]+$/) && method === "GET") {
        const id = pathname.split("/").pop();
        const petition = this.petitionManager.getPetition(id);
        if (!petition) return this._json(res, 404, { error: "Not found" });
        return this._json(res, 200, petition.toJSON());
      }

      // --- Voting ---
      if (pathname === "/api/voting/open" && method === "POST") {
        const proposal = this.proposalRegistry.get(body.proposalId);
        if (proposal && !proposal.votingConfig) {
          proposal.setVotingConfig(body.votingConfig || {});
        }
        const session = this.votingManager.openVoting(
          body.proposalId, body.actorFingerprint, body.actorPrivateKey,
        );
        this.ledger.commitBlock();
        return this._json(res, 200, { proposalId: body.proposalId, phase: session.phase });
      }
      if (pathname === "/api/voting/commit" && method === "POST") {
        const session = this.votingManager.getSession(body.proposalId);
        if (!session) return this._json(res, 404, { error: "No voting session" });
        const result = session.submitCommitment(
          body.voterFingerprint, body.commitmentHash, body.voterPrivateKey,
        );
        this.ledger.commitBlock();
        return this._json(res, 200, result);
      }
      if (pathname === "/api/voting/reveal" && method === "POST") {
        const session = this.votingManager.getSession(body.proposalId);
        if (!session) return this._json(res, 404, { error: "No voting session" });
        if (session.phase === "COMMIT") session.startRevealPhase();
        const ballot = session.revealVote(
          body.voterFingerprint, body.choice, body.nonce, body.voterPrivateKey,
        );
        this.ledger.commitBlock();
        return this._json(res, 200, { ballotId: ballot.id, choice: ballot.choice });
      }
      if (pathname === "/api/voting/finalise" && method === "POST") {
        const result = this.votingManager.finalise(
          body.proposalId, body.actorFingerprint, body.actorPrivateKey,
        );
        this.ledger.commitBlock();
        return this._json(res, 200, result);
      }

      // --- Audit ---
      if (pathname === "/api/audit/chain" && method === "GET") {
        return this._json(res, 200, this.audit.verifyChainIntegrity());
      }
      if (pathname === "/api/audit/report" && method === "GET") {
        return this._json(res, 200, this.audit.generateTransparencyReport());
      }
      if (pathname === "/api/audit/ledger" && method === "GET") {
        return this._json(res, 200, this.audit.exportLedger());
      }
      if (pathname.match(/^\/api\/audit\/entry\/[a-f0-9]+$/) && method === "GET") {
        const id = pathname.split("/").pop();
        const inclusion = this.audit.verifyEntryInclusion(id);
        const sig = this.audit.verifyEntrySignature(id);
        return this._json(res, 200, { inclusion, signature: sig });
      }
      if (pathname.match(/^\/api\/audit\/proposal\/[a-f0-9]+$/) && method === "GET") {
        const id = pathname.split("/").pop();
        return this._json(res, 200, { history: this.audit.getProposalHistory(id) });
      }
      if (pathname.match(/^\/api\/audit\/identity\/[a-f0-9]+$/) && method === "GET") {
        const id = pathname.split("/").pop();
        return this._json(res, 200, { activity: this.audit.getIdentityActivity(id) });
      }

      // --- Biometric (WebAuthn-style) ---
      if (pathname === "/api/biometric/register-challenge" && method === "POST") {
        const identity = this.identityRegistry.get(body.fingerprint);
        if (!identity) return this._json(res, 404, { error: "Identity not found" });
        if (this.biometricCredentials.has(body.fingerprint)) {
          return this._json(res, 409, { error: "Biometric already enrolled" });
        }
        const challenge = cryptoUtil.generateNonce();
        const challengeId = cryptoUtil.generateId();
        this.biometricChallenges.set(challengeId, {
          fingerprint: body.fingerprint,
          challenge,
          type: "register",
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        return this._json(res, 200, { challengeId, challenge, fingerprint: body.fingerprint });
      }
      if (pathname === "/api/biometric/register-complete" && method === "POST") {
        const pending = this.biometricChallenges.get(body.challengeId);
        if (!pending || pending.type !== "register" || Date.now() > pending.expiresAt) {
          return this._json(res, 400, { error: "Invalid or expired challenge" });
        }
        this.biometricChallenges.delete(body.challengeId);
        this.biometricCredentials.set(pending.fingerprint, {
          credentialId: body.credentialId,
          publicKeyHash: cryptoUtil.hash(body.credentialId + pending.challenge),
          counter: 0,
          enrolledAt: Date.now(),
        });
        return this._json(res, 201, { enrolled: true, fingerprint: pending.fingerprint });
      }
      if (pathname === "/api/biometric/auth-challenge" && method === "POST") {
        const cred = this.biometricCredentials.get(body.fingerprint);
        if (!cred) return this._json(res, 404, { error: "No biometric enrolled for this identity" });
        const challenge = cryptoUtil.generateNonce();
        const challengeId = cryptoUtil.generateId();
        this.biometricChallenges.set(challengeId, {
          fingerprint: body.fingerprint,
          challenge,
          credentialId: cred.credentialId,
          type: "auth",
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        return this._json(res, 200, { challengeId, challenge, credentialId: cred.credentialId });
      }
      if (pathname === "/api/biometric/auth-complete" && method === "POST") {
        const pending = this.biometricChallenges.get(body.challengeId);
        if (!pending || pending.type !== "auth" || Date.now() > pending.expiresAt) {
          return this._json(res, 400, { error: "Invalid or expired challenge" });
        }
        const cred = this.biometricCredentials.get(pending.fingerprint);
        if (!cred || cred.credentialId !== body.credentialId) {
          return this._json(res, 403, { error: "Credential mismatch" });
        }
        this.biometricChallenges.delete(body.challengeId);
        cred.counter++;
        return this._json(res, 200, { authenticated: true, fingerprint: pending.fingerprint });
      }
      if (pathname === "/api/biometric/status" && method === "POST") {
        const enrolled = this.biometricCredentials.has(body.fingerprint);
        return this._json(res, 200, { fingerprint: body.fingerprint, enrolled });
      }

      // --- Stats ---
      if (pathname === "/api/stats" && method === "GET") {
        return this._json(res, 200, {
          ledger: this.ledger.stats(),
          identities: this.identityRegistry.stats(),
          proposals: this.proposalRegistry.stats(),
          voting: this.votingManager.stats(),
          petitions: this.petitionManager.stats(),
        });
      }

      this._json(res, 404, { error: "Unknown API endpoint" });
    } catch (err) {
      this._json(res, 400, { error: err.message });
    }
  }

  _json(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  }

  _serveFile(res, relativePath, contentType) {
    const filePath = path.join(__dirname, relativePath);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      this._json(res, 404, { error: "File not found" });
    }
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }
}

module.exports = { GovernanceServer };
