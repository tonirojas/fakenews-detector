/**
 * sidepanel/sidepanel.js — ES module
 * Displays claim verdicts in the browser side panel (or as a standalone page
 * on mobile, where the panel falls back to a regular tab).
 *
 * Mobile tab-fallback note: when openResultsPanel() opens this page as a tab,
 * the "active" tab in the current window IS this page. The init() function
 * detects that case and falls back to the most recently accessed http(s) tab
 * so it listens on the correct analysis target.
 */

import { api } from "../lib/webext.js";
import { initTheme } from "../lib/theme.js";

// Apply theme as early as possible to minimise flash of wrong theme
initTheme(document);

// ---------------------------------------------------------------------------
// Inline verdict UI map (mirrors lib/strings.js)
// ---------------------------------------------------------------------------
const VERDICT_UI = {
  true:         { label: "Lo que dice es verdad",                colorClass: "green" },
  uncertain:    { label: "Peligro, podría estar mintiendo",      colorClass: "amber" },
  false:        { label: "Peligro, FAKE NEW confirmada",         colorClass: "red"   },
  unverifiable: { label: "Sin datos suficientes para verificar", colorClass: "gray"  },
};

const PROVIDER_NAMES = {
  anthropic: "Anthropic",
  openai:    "OpenAI",
  gemini:    "Gemini",
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const overallChip       = document.getElementById("overall-chip");
const overallConfidence = document.getElementById("overall-confidence");
const statusLine        = document.getElementById("status-line");
const claimsList        = document.getElementById("claims-list");
const btnClear          = document.getElementById("btn-clear");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allClaims = [];
let activeTabId = null;

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
function renderOverall(overall) {
  if (!overall) {
    overallChip.className = "overall-chip none";
    overallChip.textContent = "Sin análisis";
    overallConfidence.textContent = "";
    return;
  }
  const ui = VERDICT_UI[overall.verdict] ?? VERDICT_UI.unverifiable;
  overallChip.className = `overall-chip ${ui.colorClass}`;
  overallChip.textContent = ui.label;
  overallConfidence.textContent =
    overall.confidence != null ? `Confianza: ${overall.confidence}%` : "";
}

function createClaimCard(claim) {
  const ui = VERDICT_UI[claim.verdict] ?? VERDICT_UI.unverifiable;
  const card = document.createElement("div");
  card.className = `claim-card ${ui.colorClass}`;

  // Verdict chip
  const chip = document.createElement("div");
  chip.className = `claim-verdict-chip ${ui.colorClass}`;
  chip.textContent = ui.label;
  card.appendChild(chip);

  // Claim text
  const textEl = document.createElement("div");
  textEl.className = "claim-text";
  textEl.textContent = claim.text;
  card.appendChild(textEl);

  // Confidence bar
  const barWrap = document.createElement("div");
  barWrap.className = "confidence-bar-wrap";
  const barFill = document.createElement("div");
  barFill.className = `confidence-bar-fill ${ui.colorClass}`;
  barFill.style.width = `${claim.confidence ?? 0}%`;
  barWrap.appendChild(barFill);
  card.appendChild(barWrap);

  const confLabel = document.createElement("div");
  confLabel.className = "claim-confidence-label";
  confLabel.textContent = `Confianza: ${claim.confidence ?? 0}%`;
  card.appendChild(confLabel);

  // Reasoning
  if (claim.reasoning) {
    const reasoning = document.createElement("div");
    reasoning.className = "claim-reasoning";
    reasoning.textContent = claim.reasoning;
    card.appendChild(reasoning);
  }

  // Sources
  if (Array.isArray(claim.sources) && claim.sources.length > 0) {
    const srcTitle = document.createElement("div");
    srcTitle.className = "sources-title";
    srcTitle.textContent = "Fuentes";
    card.appendChild(srcTitle);

    const srcList = document.createElement("ul");
    srcList.className = "sources-list";
    for (const src of claim.sources) {
      const li = document.createElement("li");
      // LLM output is untrusted — only link out to http(s) URLs.
      let safeUrl = null;
      try {
        const parsed = new URL(src.url);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          safeUrl = parsed.href;
        }
      } catch {
        // Invalid URL — fall through to plain text
      }
      if (safeUrl) {
        const a = document.createElement("a");
        a.href = safeUrl;
        a.textContent = src.title || safeUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.appendChild(a);
      } else {
        li.textContent = src.title || String(src.url ?? "");
      }
      srcList.appendChild(li);
    }
    card.appendChild(srcList);
  }

  return card;
}

function renderClaims() {
  claimsList.innerHTML = "";
  if (allClaims.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Inicia un análisis desde el popup para ver los resultados aquí.";
    claimsList.appendChild(empty);
    return;
  }
  for (const claim of allClaims) {
    claimsList.appendChild(createClaimCard(claim));
  }
}

function showError(message) {
  // Remove any existing error banners
  claimsList.querySelectorAll(".error-banner").forEach((el) => el.remove());
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = message;
  claimsList.prepend(banner);
}

function updateStatusLine(mode, provider) {
  const modeLabel = mode === "audio" ? "Audio/vídeo" : mode === "text" ? "Texto" : "—";
  const now = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  statusLine.textContent =
    `Proveedor: ${PROVIDER_NAMES[provider] ?? provider ?? "—"} · Modo: ${modeLabel} · ${now}`;
}

// ---------------------------------------------------------------------------
// Handle incoming verdict update
// ---------------------------------------------------------------------------
function handleVerdictUpdate(message) {
  if (message.tabId !== activeTabId) return;

  if (Array.isArray(message.claims)) {
    allClaims = [...message.claims, ...allClaims].slice(0, 60); // keep last 60
  }

  renderOverall(message.overall);
  renderClaims();

  api.storage.local.get(["provider", "model"]).then((s) => {
    updateStatusLine(null, s.provider);
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Init — get active tab + current state
// Mobile fix: when this page itself is the active tab, fall back to the most
// recently accessed http(s) tab so we listen on the right analysis target.
// ---------------------------------------------------------------------------
async function init() {
  try {
    let [tab] = await api.tabs.query({ active: true, currentWindow: true });

    // Detect the mobile fallback: sidepanel opened as a regular tab means IT
    // is the "active" tab. Check by comparing the URL to our own extension origin.
    const ownOrigin = api.runtime.getURL("");
    if (!tab || tab.url?.startsWith(ownOrigin)) {
      // Find the most recently accessed http(s) tab in the current window
      const allTabs = await api.tabs.query({ currentWindow: true });
      const httpTabs = allTabs.filter(
        (t) => t.url?.startsWith("http://") || t.url?.startsWith("https://")
      );
      // Sort descending by lastAccessed if available (Chrome exposes it; fallback to index order)
      httpTabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
      tab = httpTabs[0] ?? null;
    }

    if (tab) activeTabId = tab.id;

    const settings = await api.storage.local.get(["provider"]);

    if (activeTabId) {
      api.runtime.sendMessage({ type: "GET_STATE", tabId: activeTabId })
        .then((state) => {
          if (!state?.results?.length) return;
          const last = state.results[state.results.length - 1];
          allClaims = last.claims ?? [];
          renderOverall(last.overall);
          renderClaims();
          updateStatusLine(state.mode, settings.provider);
        })
        .catch(() => {});
    }
  } catch {
    // Side panel may open before a tab is active
  }
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------
api.runtime.onMessage.addListener((message) => {
  if (message.type === "VERDICT_UPDATE") {
    handleVerdictUpdate(message);
  }
  if (message.type === "ANALYSIS_ERROR" && message.tabId === activeTabId) {
    showError(message.message ?? "Error desconocido");
  }
});

// ---------------------------------------------------------------------------
// Clear button
// ---------------------------------------------------------------------------
btnClear.addEventListener("click", () => {
  allClaims = [];
  renderOverall(null);
  renderClaims();
  statusLine.textContent = "Esperando análisis…";
});

init();
