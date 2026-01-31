/* OpenGov Dashboard — Client-side logic with Biometric Auth */

(function () {
  "use strict";

  const API = "";

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  async function api(path, method = "GET", body = null) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    return res.json();
  }

  function show(el, data, type) {
    el.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    el.className = "output" + (type ? " " + type : "");
  }

  function formData(form) {
    const fd = new FormData(form);
    const obj = {};
    for (const [k, v] of fd.entries()) obj[k] = v;
    return obj;
  }

  const $ = (s) => document.getElementById(s);
  const $$ = (s) => document.querySelectorAll(s);

  // -----------------------------------------------------------------------
  // Tab navigation
  // -----------------------------------------------------------------------

  const pageTitles = {
    overview: "System Overview",
    identity: "Identity Management",
    proposals: "Proposals",
    petitions: "Petitions",
    voting: "Voting",
    audit: "Audit & Verification",
  };

  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".nav-item").forEach((b) => b.classList.remove("active"));
      $$(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      $("tab-" + btn.dataset.tab).classList.add("active");
      $("page-title").textContent = pageTitles[btn.dataset.tab] || "";
    });
  });

  // -----------------------------------------------------------------------
  // Overview — load stats
  // -----------------------------------------------------------------------

  async function loadStats() {
    try {
      const stats = await api("/api/stats");
      $("stat-blocks").textContent = stats.ledger.blocks;
      $("stat-entries").textContent = stats.ledger.totalEntries;
      $("stat-identities").textContent = stats.identities.active;
      $("stat-proposals").textContent = stats.proposals.total;
      $("stat-petitions").textContent = stats.petitions.active;

      const valid = stats.ledger.chainValid;
      $("stat-chain-valid").textContent = valid ? "Valid" : "Invalid";
      $("stat-chain-valid").style.color = valid ? "var(--green)" : "var(--red)";

      const badge = $("chain-badge");
      badge.className = "chain-badge " + (valid ? "valid" : "invalid");
      badge.querySelector("span:last-child") || badge.append("");
      badge.lastChild.textContent = valid ? " Chain Verified" : " Chain Invalid";
    } catch (e) {
      console.error("Stats load failed:", e);
    }
  }

  loadStats();
  setInterval(loadStats, 5000);

  // -----------------------------------------------------------------------
  // Identity
  // -----------------------------------------------------------------------

  $("btn-generate-keys").addEventListener("click", async () => {
    const data = await api("/api/identity/generate-keypair", "POST");
    show($("keypair-output"), data);
  });

  $("form-register").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const data = await api("/api/identity/register", "POST", formData(e.target));
      show($("register-output"), data, "ok");
      loadStats();
    } catch (err) {
      show($("register-output"), "Error: " + err.message, "err");
    }
  });

  $("btn-list-identities").addEventListener("click", async () => {
    const data = await api("/api/identity/list");
    show($("identity-list"), data);
  });

  // -----------------------------------------------------------------------
  // Proposals
  // -----------------------------------------------------------------------

  $("form-proposal").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = formData(e.target);
    body.implications = body.implications.split("\n").filter((l) => l.trim());
    try {
      const data = await api("/api/proposal/create", "POST", body);
      show($("proposal-output"), data, "ok");
      loadStats();
    } catch (err) {
      show($("proposal-output"), "Error: " + err.message, "err");
    }
  });

  $("btn-list-proposals").addEventListener("click", async () => {
    show($("proposal-list"), await api("/api/proposal/list"));
  });

  // -----------------------------------------------------------------------
  // Petitions
  // -----------------------------------------------------------------------

  $("form-open-petition").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = formData(e.target);
    body.threshold = parseInt(body.threshold, 10) || 300;
    try {
      const data = await api("/api/proposal/open-petition", "POST", body);
      show($("open-petition-output"), data, "ok");
      loadStats();
    } catch (err) {
      show($("open-petition-output"), "Error: " + err.message, "err");
    }
  });

  $("form-sign-petition").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const data = await api("/api/petition/sign", "POST", formData(e.target));
      show($("sign-petition-output"), data, "ok");
      loadStats();
    } catch (err) {
      show($("sign-petition-output"), "Error: " + err.message, "err");
    }
  });

  // -----------------------------------------------------------------------
  // Biometric Authentication (WebAuthn)
  // -----------------------------------------------------------------------

  const webAuthnAvailable = !!(navigator.credentials && window.PublicKeyCredential);

  function bufToBase64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function strToBuffer(str) {
    return new TextEncoder().encode(str);
  }

  // Enroll biometric credential for an identity
  async function enrollBiometric(fingerprint) {
    if (!webAuthnAvailable) throw new Error("WebAuthn not supported in this browser");

    // Get registration challenge from server
    const challengeResp = await api("/api/biometric/register-challenge", "POST", { fingerprint });
    if (challengeResp.error) throw new Error(challengeResp.error);

    // Create credential via platform authenticator (fingerprint / face)
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: strToBuffer(challengeResp.challenge),
        rp: { name: "OpenGov Governance", id: location.hostname },
        user: {
          id: strToBuffer(fingerprint),
          name: fingerprint.slice(0, 16) + "...",
          displayName: "OpenGov Citizen",
        },
        pubKeyCredParams: [
          { alg: -7, type: "public-key" },   // ES256
          { alg: -257, type: "public-key" },  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 120000,
        attestation: "none",
      },
    });

    // Complete registration on server
    const result = await api("/api/biometric/register-complete", "POST", {
      challengeId: challengeResp.challengeId,
      credentialId: bufToBase64(credential.rawId),
    });
    if (result.error) throw new Error(result.error);
    return result;
  }

  // Authenticate with biometric before voting
  async function authenticateBiometric(fingerprint) {
    if (!webAuthnAvailable) throw new Error("WebAuthn not supported in this browser");

    // Check enrollment
    const status = await api("/api/biometric/status", "POST", { fingerprint });
    if (!status.enrolled) throw new Error("ENROLL_REQUIRED");

    // Get auth challenge
    const challengeResp = await api("/api/biometric/auth-challenge", "POST", { fingerprint });
    if (challengeResp.error) throw new Error(challengeResp.error);

    // Authenticate via platform authenticator
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: strToBuffer(challengeResp.challenge),
        rpId: location.hostname,
        allowCredentials: [{
          type: "public-key",
          id: Uint8Array.from(atob(challengeResp.credentialId), c => c.charCodeAt(0)),
        }],
        userVerification: "required",
        timeout: 120000,
      },
    });

    // Complete auth on server
    const result = await api("/api/biometric/auth-complete", "POST", {
      challengeId: challengeResp.challengeId,
      credentialId: bufToBase64(assertion.rawId),
    });
    if (result.error) throw new Error(result.error);
    return result;
  }

  // -----------------------------------------------------------------------
  // Biometric Enrollment UI
  // -----------------------------------------------------------------------

  $("btn-enroll-bio").addEventListener("click", () => {
    $("bio-enroll-overlay").classList.remove("hidden");
    $("enroll-status").textContent = "";
    $("enroll-status").className = "bio-status";
  });

  $("bio-enroll-cancel").addEventListener("click", () => {
    $("bio-enroll-overlay").classList.add("hidden");
  });

  $("bio-enroll-btn").addEventListener("click", async () => {
    const fp = $("enroll-fingerprint").value.trim();
    if (!fp) {
      $("enroll-status").textContent = "Please enter your identity fingerprint.";
      $("enroll-status").className = "bio-status err";
      return;
    }
    $("enroll-status").textContent = "Waiting for biometric sensor...";
    $("enroll-status").className = "bio-status";
    try {
      await enrollBiometric(fp);
      $("enroll-status").textContent = "Biometric enrolled successfully!";
      $("enroll-status").className = "bio-status ok";
      setTimeout(() => $("bio-enroll-overlay").classList.add("hidden"), 1500);
    } catch (err) {
      $("enroll-status").textContent = "Enrollment failed: " + err.message;
      $("enroll-status").className = "bio-status err";
    }
  });

  // -----------------------------------------------------------------------
  // Voting — with biometric gate
  // -----------------------------------------------------------------------

  $("form-open-voting").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const data = await api("/api/voting/open", "POST", formData(e.target));
      show($("open-voting-output"), data, "ok");
      loadStats();
    } catch (err) {
      show($("open-voting-output"), "Error: " + err.message, "err");
    }
  });

  // The main vote form — intercept and require biometric auth first
  let pendingVoteData = null;

  $("form-vote-commit").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = formData(e.target);
    if (!body.choice) {
      show($("vote-output"), "Please select Yea, Nay, or Abstain.", "err");
      return;
    }

    pendingVoteData = body;

    // Show biometric auth overlay
    $("bio-overlay").classList.remove("hidden");
    $("bio-status").textContent = "";
    $("bio-status").className = "bio-status";
    $("bio-title").textContent = "Biometric Verification Required";
    $("bio-message").textContent =
      "Authenticate your identity before casting your vote. This ensures one-person-one-vote integrity.";
  });

  $("bio-cancel").addEventListener("click", () => {
    $("bio-overlay").classList.add("hidden");
    pendingVoteData = null;
  });

  $("bio-trigger").addEventListener("click", async () => {
    if (!pendingVoteData) return;

    $("bio-status").textContent = "Waiting for biometric...";
    $("bio-status").className = "bio-status";

    try {
      await authenticateBiometric(pendingVoteData.voterFingerprint);

      $("bio-status").textContent = "Authenticated! Casting vote...";
      $("bio-status").className = "bio-status ok";

      // Now actually cast the vote (commit + reveal)
      await castVote(pendingVoteData);

      setTimeout(() => $("bio-overlay").classList.add("hidden"), 800);
      pendingVoteData = null;
    } catch (err) {
      if (err.message === "ENROLL_REQUIRED") {
        $("bio-status").textContent = "No biometric enrolled. Please enroll first using the sidebar button.";
        $("bio-status").className = "bio-status err";
      } else {
        $("bio-status").textContent = "Auth failed: " + err.message;
        $("bio-status").className = "bio-status err";
      }
    }
  });

  async function castVote(body) {
    const out = $("vote-output");

    // Generate nonce and commitment client-side
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const encoder = new TextEncoder();
    const commitData = encoder.encode(body.choice + nonce);
    const hashBuf = await crypto.subtle.digest("SHA-256", commitData);
    const commitmentHash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0")).join("");

    // Commit phase
    await api("/api/voting/commit", "POST", {
      proposalId: body.proposalId,
      voterFingerprint: body.voterFingerprint,
      commitmentHash,
      voterPrivateKey: body.voterPrivateKey,
    });

    // Reveal phase
    const revealData = await api("/api/voting/reveal", "POST", {
      proposalId: body.proposalId,
      voterFingerprint: body.voterFingerprint,
      choice: body.choice,
      nonce,
      voterPrivateKey: body.voterPrivateKey,
    });

    show(out, { committed: true, revealed: true, biometricVerified: true, ...revealData }, "ok");
    loadStats();
  }

  $("form-finalise").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const data = await api("/api/voting/finalise", "POST", formData(e.target));
      show($("finalise-output"), data, "ok");
      loadStats();
    } catch (err) {
      show($("finalise-output"), "Error: " + err.message, "err");
    }
  });

  // -----------------------------------------------------------------------
  // Audit
  // -----------------------------------------------------------------------

  $("btn-verify-chain").addEventListener("click", async () => {
    const data = await api("/api/audit/chain");
    show($("chain-verify-output"), data, data.valid ? "ok" : "err");
  });

  $("btn-transparency-report").addEventListener("click", async () => {
    show($("report-output"), await api("/api/audit/report"));
  });

  $("form-verify-entry").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = formData(e.target);
    show($("entry-verify-output"), await api("/api/audit/entry/" + body.entryId));
  });

  $("btn-export-ledger").addEventListener("click", async () => {
    show($("ledger-export-output"), await api("/api/audit/ledger"));
  });
})();
