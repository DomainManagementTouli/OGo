/**
 * core/crypto.js — Cryptographic primitives for OpenGov
 *
 * Provides hashing, key-pair generation, digital signatures, Merkle trees,
 * and commitment schemes used throughout the system. All functions use
 * Node.js built-in `crypto` module — zero external dependencies.
 */

"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HASH_ALGO = "sha3-256";
const SIGN_ALGO = "ed25519"; // Edwards-curve — compact, fast, deterministic
const SYMMETRIC_ALGO = "aes-256-gcm";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-3-256 hex digest of arbitrary data.
 * Accepts strings, Buffers, or objects (JSON-serialised deterministically).
 */
function hash(data) {
  const payload =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data
        : stableStringify(data);
  return crypto.createHash(HASH_ALGO).update(payload).digest("hex");
}

/**
 * Deterministic JSON serialisation (sorted keys) so the same logical object
 * always produces the same hash regardless of property insertion order.
 */
function stableStringify(obj) {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((v) => stableStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

// ---------------------------------------------------------------------------
// Key-pair generation & digital signatures (Ed25519)
// ---------------------------------------------------------------------------

/**
 * Generate an Ed25519 key pair.
 * Returns { publicKey, privateKey } as PEM strings.
 */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(SIGN_ALGO, {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

/**
 * Return a compact hex fingerprint for a public key PEM.
 */
function fingerprintPublicKey(publicKeyPem) {
  return hash(publicKeyPem.trim());
}

/**
 * Sign a payload (string | Buffer | object) with a private key PEM.
 * Returns a hex-encoded signature.
 */
function sign(payload, privateKeyPem) {
  const data =
    typeof payload === "string"
      ? payload
      : Buffer.isBuffer(payload)
        ? payload
        : stableStringify(payload);
  return crypto.sign(null, Buffer.from(data), privateKeyPem).toString("hex");
}

/**
 * Verify a hex-encoded signature against a payload and public key PEM.
 */
function verify(payload, signatureHex, publicKeyPem) {
  const data =
    typeof payload === "string"
      ? payload
      : Buffer.isBuffer(payload)
        ? payload
        : stableStringify(payload);
  return crypto.verify(
    null,
    Buffer.from(data),
    publicKeyPem,
    Buffer.from(signatureHex, "hex"),
  );
}

// ---------------------------------------------------------------------------
// Merkle Tree
// ---------------------------------------------------------------------------

class MerkleTree {
  /**
   * @param {string[]} leaves — hex hashes of leaf data
   */
  constructor(leaves) {
    if (!leaves || leaves.length === 0) {
      this.leaves = [];
      this.layers = [[]];
      this.root = hash("");
      return;
    }
    this.leaves = [...leaves];
    this.layers = [this.leaves];
    this._build();
  }

  _build() {
    let current = this.leaves;
    while (current.length > 1) {
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = i + 1 < current.length ? current[i + 1] : left;
        next.push(hash(left + right));
      }
      this.layers.push(next);
      current = next;
    }
    this.root = current[0];
  }

  /**
   * Generate an inclusion proof for the leaf at `index`.
   * Returns an array of { hash, position } objects.
   */
  getProof(index) {
    const proof = [];
    for (let layer = 0; layer < this.layers.length - 1; layer++) {
      const isRight = index % 2 === 1;
      const siblingIdx = isRight ? index - 1 : index + 1;
      if (siblingIdx < this.layers[layer].length) {
        proof.push({
          hash: this.layers[layer][siblingIdx],
          position: isRight ? "left" : "right",
        });
      }
      index = Math.floor(index / 2);
    }
    return proof;
  }

  /**
   * Verify an inclusion proof.
   */
  static verifyProof(leafHash, proof, root) {
    let current = leafHash;
    for (const step of proof) {
      current =
        step.position === "left"
          ? hash(step.hash + current)
          : hash(current + step.hash);
    }
    return current === root;
  }
}

// ---------------------------------------------------------------------------
// Commitment scheme (hash-based, for ballot secrecy during voting period)
// ---------------------------------------------------------------------------

function createCommitment(value, nonce) {
  if (!nonce) nonce = crypto.randomBytes(32).toString("hex");
  return { commitment: hash(value + nonce), nonce };
}

function openCommitment(value, nonce, commitment) {
  return hash(value + nonce) === commitment;
}

// ---------------------------------------------------------------------------
// Symmetric encryption helpers (AES-256-GCM) — for encrypted ballot storage
// ---------------------------------------------------------------------------

function symmetricEncrypt(plaintext, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(SYMMETRIC_ALGO, key, iv);
  let enc = cipher.update(plaintext, "utf8", "hex");
  enc += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return { iv: iv.toString("hex"), ciphertext: enc, tag };
}

function symmetricDecrypt(ciphertextObj, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  const decipher = crypto.createDecipheriv(
    SYMMETRIC_ALGO,
    key,
    Buffer.from(ciphertextObj.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(ciphertextObj.tag, "hex"));
  let dec = decipher.update(ciphertextObj.ciphertext, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

function generateSymmetricKey() {
  return crypto.randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Unique ID generation
// ---------------------------------------------------------------------------

function generateId() {
  return crypto.randomBytes(16).toString("hex");
}

function generateNonce() {
  return crypto.randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  HASH_ALGO,
  hash,
  stableStringify,
  generateKeyPair,
  fingerprintPublicKey,
  sign,
  verify,
  MerkleTree,
  createCommitment,
  openCommitment,
  symmetricEncrypt,
  symmetricDecrypt,
  generateSymmetricKey,
  generateId,
  generateNonce,
};
