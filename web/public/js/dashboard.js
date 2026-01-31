/* OpenGov Dashboard — Client-side logic */

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

  function show(el, data) {
    el.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    el.classList.add("visible");
  }

  function formData(form) {
    const fd = new FormData(form);
    const obj = {};
    for (const [k, v] of fd.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  // -----------------------------------------------------------------------
  // Tab navigation
  // -----------------------------------------------------------------------

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    });
  });

  // -----------------------------------------------------------------------
  // Overview — load stats
  // -----------------------------------------------------------------------

  async function loadStats() {
    try {
      const stats = await api("/api/stats");
      document.getElementById("stat-chain-valid").textContent =
        stats.ledger.chainValid ? "✓ Valid" : "✗ Invalid";
      document.getElementById("stat-chain-valid").className =
        "stat-value " + (stats.ledger.chainValid ? "valid" : "invalid");
      document.getElementById("stat-blocks").textContent = stats.ledger.blocks;
      document.getElementById("stat-entries").textContent = stats.ledger.totalEntries;
      document.getElementById("stat-identities").textContent = stats.identities.active;
      document.getElementById("stat-proposals").textContent = stats.proposals.total;
      document.getElementById("stat-petitions").textContent = stats.petitions.active;
    } catch (e) {
      console.error("Failed to load stats:", e);
    }
  }

  loadStats();
  setInterval(loadStats, 5000);

  // -----------------------------------------------------------------------
  // Identity
  // -----------------------------------------------------------------------

  document.getElementById("btn-generate-keys").addEventListener("click", async () => {
    const out = document.getElementById("keypair-output");
    const data = await api("/api/identity/generate-keypair", "POST");
    show(out, data);
  });

  document.getElementById("form-register").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.getElementById("register-output");
    const body = formData(e.target);
    try {
      const data = await api("/api/identity/register", "POST", body);
      show(out, data);
      loadStats();
    } catch (err) {
      show(out, "Error: " + err.message);
    }
  });

  document.getElementById("btn-list-identities").addEventListener("click", async () => {
    const out = document.getElementById("identity-list");
    const data = await api("/api/identity/list");
    show(out, data);
  });

  // -----------------------------------------------------------------------
  // Proposals
  // -----------------------------------------------------------------------

  document.getElementById("form-proposal").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.getElementById("proposal-output");
    const body = formData(e.target);
    body.implications = body.implications.split("\n").filter((l) => l.trim());
    try {
      const data = await api("/api/proposal/create", "POST", body);
      show(out, data);
      loadStats();
    } catch (err) {
      show(out, "Error: " + err.message);
    }
  });

  document.getElementById("btn-list-proposals").addEventListener("click", async () => {
    const out = document.getElementById("proposal-list");
    const data = await api("/api/proposal/list");
    show(out, data);
  });

  // -----------------------------------------------------------------------
  // Petitions
  // -----------------------------------------------------------------------

  document.getElementById("form-open-petition").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.getElementById("open-petition-output");
    const body = formData(e.target);
    body.threshold = parseInt(body.threshold, 10) || 300;
    try {
      const data = await api("/api/proposal/open-petition", "POST", body);
      show(out, data);
      loadStats();
    } catch (err) {
      show(out, "Error: " + err.message);
    }
  });

  document.getElementById("form-sign-petition").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.getElementById("sign-petition-output");
    const body = formData(e.target);
    try {
      const data = await api("/api/petition/sign", "POST", body);
      show(out, data);
      loadStats();
    } catch (err) {
      show(out, "Error: " + err.message);
    }
  });

  // -----------------------------------------------------------------------
  // Voting
  // -----------------------------------------------------------------------

  document.getElementById("form-open-voting").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.getElementById("open-voting-output");
    const body = formData(e.target);
    try {
      const data = await api("/api/voting/open", "POST", body);
      show(out, data);
      loadStats();
    } catch (err) {
      show(out, "Error: " + err.message);
    }
  });

  document.getElementById("form-vote-commit").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.getElementById("vote-output");
    const body = formData(e.target);

    // Generate nonce and commitment client-side
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const encoder = new TextEncoder();
    const commitData = encoder.encode(body.choice + nonce);
    const hashBuf = await crypto.subtle.digest("SHA-256", commitData);
    const commitmentHash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0")).join("");

    try {
      // Commit
      await api("/api/voting/commit", "POST", {
        proposalId: body.proposalId,
        voterFingerprint: body.voterFingerprint,
        commitmentHash,
        voterPrivateKey: body.voterPrivateKey,
      });

      // Reveal
      const revealData = await api("/api/voting/reveal", "POST", {
        proposalId: body.proposalId,
        voterFingerprint: body.voterFingerprint,
        choice: body.choice,
        nonce,
        voterPrivateKey: body.voterPrivateKey,
      });

      show(out, { committed: true, revealed: true, ...revealData });
      loadStats();
    } catch (err) {
      show(out, "Error: " + err.message);
    }
  });

  document.getElementById("form-finalise").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.getElementById("finalise-output");
    const body = formData(e.target);
    try {
      const data = await api("/api/voting/finalise", "POST", body);
      show(out, data);
      loadStats();
    } catch (err) {
      show(out, "Error: " + err.message);
    }
  });

  // -----------------------------------------------------------------------
  // Audit
  // -----------------------------------------------------------------------

  document.getElementById("btn-verify-chain").addEventListener("click", async () => {
    const out = document.getElementById("chain-verify-output");
    const data = await api("/api/audit/chain");
    show(out, data);
  });

  document.getElementById("btn-transparency-report").addEventListener("click", async () => {
    const out = document.getElementById("report-output");
    const data = await api("/api/audit/report");
    show(out, data);
  });

  document.getElementById("form-verify-entry").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.getElementById("entry-verify-output");
    const body = formData(e.target);
    const data = await api("/api/audit/entry/" + body.entryId);
    show(out, data);
  });

  document.getElementById("btn-export-ledger").addEventListener("click", async () => {
    const out = document.getElementById("ledger-export-output");
    const data = await api("/api/audit/ledger");
    show(out, data);
  });
})();
