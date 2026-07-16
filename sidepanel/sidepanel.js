/**
 * sidepanel/sidepanel.js — ES module
 * Displays claim verdicts in the browser side panel (or as a standalone page
 * on mobile, where the panel falls back to a regular tab).
 *
 * Mobile tab-fallback note: when openResultsPanel() opens this page as a tab,
 * the "active" tab in the current window IS this page. The init() function
 * detects that case and falls back to the most recently accessed http(s) tab
 * so it listens on the correct analysis target.
 *
 * Tab-follow: after init the panel stays in sync via api.tabs.onActivated
 * (tab switch) and api.tabs.onUpdated (same-tab navigation). Both listeners
 * are wrapped in try/catch because onActivated is unavailable in the mobile
 * tab-fallback context on some platforms.
 */

import { api } from "../lib/webext.js";
import { initTheme } from "../lib/theme.js";
import { getProvider } from "../lib/models.js";

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


// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const overallChip       = document.getElementById("overall-chip");
const overallConfidence = document.getElementById("overall-confidence");
const statusLine        = document.getElementById("status-line");
const claimsList        = document.getElementById("claims-list");
const btnClear          = document.getElementById("btn-clear");
const vuBarsEl          = document.getElementById("vu-bars");
const vuLabelEl         = document.getElementById("vu-label");

// ---------------------------------------------------------------------------
// VU meter
// Create 16 LED-style bar segments. Bars light up left→right proportional to
// the audio level. Color ramp: green (low) → amber (mid) → red (peak).
// Uses requestAnimationFrame with smooth exponential decay so the meter
// animates fluidly and falls back to zero ~400 ms after capture stops.
// The rAF loop is paused when the panel is hidden (visibilitychange) to avoid
// running an animation nobody can see.
// ---------------------------------------------------------------------------
const VU_BAR_COUNT = 16;
const vuBarEls     = [];

if (vuBarsEl) {
  for (let i = 0; i < VU_BAR_COUNT; i++) {
    const bar = document.createElement("div");
    bar.className = "vu-bar";
    vuBarsEl.appendChild(bar);
    vuBarEls.push(bar);
  }
}

let vuCurrentLevel  = 0;   // smoothed display level 0-100
let vuTargetLevel   = 0;   // latest value from AUDIO_LEVEL message
let vuLastMessageMs = 0;   // timestamp of last AUDIO_LEVEL message
let vuRafId         = null; // requestAnimationFrame handle for cancellation

function updateVuBars(level) {
  if (!vuBarEls.length) return;
  const litCount = Math.round((level / 100) * VU_BAR_COUNT);
  for (let i = 0; i < VU_BAR_COUNT; i++) {
    const bar = vuBarEls[i];
    if (!bar) continue;
    let targetClass;
    if (i < litCount) {
      // Position-based colour: 0-62 % green, 63-87 % amber, 88-100 % red
      const pct = (i / VU_BAR_COUNT) * 100;
      targetClass = pct < 62.5 ? "vu-bar lit-green"
                  : pct < 87.5 ? "vu-bar lit-amber"
                  :              "vu-bar lit-red";
    } else {
      targetClass = "vu-bar";
    }
    // Skip write when className is already correct to avoid needless DOM churn
    if (bar.className !== targetClass) bar.className = targetClass;
  }
}

function vuTick() {
  // Decay to silence when no AUDIO_LEVEL messages for >400 ms
  if (Date.now() - vuLastMessageMs > 400) {
    vuTargetLevel = 0;
    // Reset label to neutral when the meter has fully decayed to silence
    if (vuLabelEl && vuCurrentLevel < 2 && vuLabelEl.textContent !== "Nivel de audio") {
      vuLabelEl.textContent = "Nivel de audio";
    }
  }
  vuCurrentLevel += (vuTargetLevel - vuCurrentLevel) * 0.3;
  updateVuBars(vuCurrentLevel);
  vuRafId = requestAnimationFrame(vuTick);
}

// Pause the animation loop when the panel is hidden; resume when visible.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (vuRafId !== null) {
      cancelAnimationFrame(vuRafId);
      vuRafId = null;
    }
  } else {
    if (vuRafId === null) {
      vuRafId = requestAnimationFrame(vuTick);
    }
  }
});

// Kick off the animation loop
vuRafId = requestAnimationFrame(vuTick);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allClaims  = [];
let activeTabId = null;
/** Set in init() when the sidepanel is running as a regular tab (mobile fallback). */
let ownTabId    = null;
/** Window that owns this sidepanel instance. Filters onActivated events from other windows. */
let ownWindowId = null;

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
  const modeLabel = mode === "audio" ? "Audio/vídeo"
                  : mode === "mic"   ? "Micrófono"
                  : mode === "text"  ? "Texto"
                  : "—";
  const now = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  statusLine.textContent =
    `Proveedor: ${provider ? getProvider(provider).label : "—"} · Modo: ${modeLabel} · ${now}`;
}

// ---------------------------------------------------------------------------
// refreshState — fetch current tab state from background and render it.
// Called on init, tab switch, and same-tab re-navigation.
// ---------------------------------------------------------------------------
async function refreshState() {
  if (!activeTabId) return;
  try {
    const [settings, state] = await Promise.all([
      api.storage.local.get(["provider"]),
      api.runtime.sendMessage({ type: "GET_STATE", tabId: activeTabId }),
    ]);
    if (!state?.results?.length) return;
    const last = state.results[state.results.length - 1];
    allClaims = last.claims ?? [];
    renderOverall(last.overall);
    renderClaims();
    updateStatusLine(state.mode, settings.provider);
  } catch {
    // Background SW may not be ready yet — leave the empty state visible
  }
}

// ---------------------------------------------------------------------------
// switchToTab — update activeTabId, clear UI, then fetch fresh state.
// Skips the panel's own tab in mobile-fallback mode (ownTabId is set).
// ---------------------------------------------------------------------------
function switchToTab(tabId) {
  // Mobile fallback: sidepanel is itself a regular tab — ignore its own activation
  if (ownTabId !== null && tabId === ownTabId) return;
  if (tabId === activeTabId) return;

  activeTabId = tabId;
  allClaims   = [];
  renderOverall(null);
  renderClaims();
  statusLine.textContent = "Esperando análisis…";

  // Reset VU meter to neutral state
  vuTargetLevel = 0;
  if (vuLabelEl) vuLabelEl.textContent = "Nivel de audio";

  refreshState();
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
// Init — get active tab + register tab-follow listeners
// Mobile fix: when this page itself is the active tab, fall back to the most
// recently accessed http(s) tab so we listen on the right analysis target.
// ---------------------------------------------------------------------------
async function init() {
  try {
    let [tab] = await api.tabs.query({ active: true, currentWindow: true });
    // Capture window ID before any mobile-fallback reassignment so the
    // onActivated guard can filter events from other windows.
    if (tab) ownWindowId = tab.windowId;

    // Detect the mobile fallback: sidepanel opened as a regular tab means IT
    // is the "active" tab. Check by comparing the URL to our own extension origin.
    const ownOrigin = api.runtime.getURL("");
    if (!tab || tab.url?.startsWith(ownOrigin)) {
      // Store our own tab ID so switchToTab can skip it
      if (tab) ownTabId = tab.id;

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

    // Register listeners so the panel follows the active tab.
    // Wrapped in try/catch: onActivated may be unavailable on some mobile paths.
    try {
      api.tabs.onActivated.addListener(({ tabId, windowId }) => {
        // Ignore activation events from other browser windows
        if (ownWindowId !== null && windowId !== ownWindowId) return;
        switchToTab(tabId);
      });
      api.tabs.onUpdated.addListener((tabId, changeInfo) => {
        // Re-fetch state when the active tab navigates or finishes loading
        if (tabId === activeTabId && (changeInfo.status === "complete" || changeInfo.url)) {
          refreshState();
        }
      });
    } catch {
      // Tab event listeners unavailable in this context — static init only
    }

    refreshState();
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

  if (message.type === "AUDIO_LEVEL" && message.tabId === activeTabId) {
    vuTargetLevel   = typeof message.level === "number" ? message.level : 0;
    vuLastMessageMs = Date.now();
    // Update label to reflect the current source kind
    if (vuLabelEl) {
      const suffix = message.sourceKind === "mic" ? " (micrófono)" : " (pestaña)";
      vuLabelEl.textContent = "Nivel de audio" + suffix;
    }
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
