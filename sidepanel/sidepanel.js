/**
 * sidepanel/sidepanel.js — ES module
 * Displays claim verdicts in the browser side panel (or as a standalone page
 * on mobile, where the panel falls back to a regular tab).
 *
 * Panel views — only one is visible at a time; the header + toolbar stay fixed:
 *   VIEW A "results"    — live claim cards (#results-view)
 *   VIEW B "conclusion" — stats tally + animated spinner → AI text (#conclusion-view)
 *   VIEW C "history"    — per-session chronological log of analyses + conclusions (#history-view)
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

// View containers (null-guarded throughout — mobile fallback may lack them)
const resultsView    = document.getElementById("results-view");
const conclusionView = document.getElementById("conclusion-view");
const historyView    = document.getElementById("history-view");

// Toolbar buttons
const btnConclusion = document.getElementById("btn-conclusion");
const btnHistory    = document.getElementById("btn-history");

// Conclusion view refs
const conclusionStats = document.getElementById("conclusion-stats");
const conclusionBody  = document.getElementById("conclusion-body");
const btnBackFromConclusion = document.getElementById("btn-back-from-conclusion");

// History view refs
const historyList        = document.getElementById("history-list");
const btnBackFromHistory = document.getElementById("btn-back-from-history");

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

/** True while a GENERATE_CONCLUSION API call is in flight. */
let conclusionPending = false;
/** True only when GENERATE_CONCLUSION was sent and the result/error has not yet arrived.
 *  Cleared by setConclusionEmpty (no API call made), resetConclusionView (view cleared),
 *  and the CONCLUSION_RESULT/CONCLUSION_ERROR handlers once consumed.
 *  Guards the message listener against stale broadcasts from a previous session. */
let conclusionExpected = false;
/** True while a valid AI conclusion result is rendered in VIEW B for this session.
 *  Re-clicking Conclusión when this is true just re-shows VIEW B without a new API call. */
let conclusionResultShown = false;

// ---------------------------------------------------------------------------
// View switcher
// ---------------------------------------------------------------------------

/**
 * Shows one of the three content views ("results" | "conclusion" | "history")
 * by toggling the [hidden] attribute. The header and toolbar are unaffected.
 * @param {"results"|"conclusion"|"history"} name
 */
function showView(name) {
  if (resultsView)    resultsView.hidden    = (name !== "results");
  if (conclusionView) conclusionView.hidden = (name !== "conclusion");
  if (historyView)    historyView.hidden    = (name !== "history");
}

// ---------------------------------------------------------------------------
// Conclusion view helpers
// ---------------------------------------------------------------------------

/**
 * Computes verdict counts and average confidence from a claims array.
 * @param {Array} claims
 * @returns {{ counts: Record<string,number>, avgConf: number, total: number }}
 */
function computeVerdictStats(claims) {
  const counts = { true: 0, false: 0, uncertain: 0, unverifiable: 0 };
  let totalConf = 0;
  for (const c of claims) {
    if (c.verdict in counts) counts[c.verdict]++;
    totalConf += c.confidence ?? 0;
  }
  const avgConf = claims.length > 0 ? Math.round(totalConf / claims.length) : 0;
  return { counts, avgConf, total: claims.length };
}

/**
 * Renders verdict tally pills into the given container element.
 * Shared by the conclusion view stats and history entry conclusion detail.
 * @param {HTMLElement} container
 * @param {{ counts: Record<string,number>, avgConf: number, total: number }} stats
 */
function renderStatsInto(container, stats) {
  const items = [
    { key: "true",         label: "Verdadera",     colorClass: "green" },
    { key: "uncertain",    label: "Dudosa",         colorClass: "amber" },
    { key: "false",        label: "Falsa",          colorClass: "red"   },
    { key: "unverifiable", label: "No verificable", colorClass: "gray"  },
  ];

  for (const { key, label, colorClass } of items) {
    const chip = document.createElement("span");
    chip.className = `conclusion-stat ${colorClass}`;
    chip.textContent = `${label}: ${stats.counts[key]}`;
    container.appendChild(chip);
  }

  const confEl = document.createElement("span");
  confEl.className = "conclusion-stat-conf";
  confEl.textContent = `Confianza media: ${stats.avgConf}%`;
  container.appendChild(confEl);
}

/**
 * Renders the verdict tally pills into #conclusion-stats.
 * @param {{ counts: Record<string,number>, avgConf: number, total: number }} stats
 */
function renderConclusionStats(stats) {
  if (!conclusionStats) return;
  conclusionStats.textContent = "";
  renderStatsInto(conclusionStats, stats);
}

/** Clears the #conclusion-body element. */
function clearConclusionBody() {
  if (conclusionBody) conclusionBody.textContent = "";
}

/**
 * Shows the animated CSS spinner + "Generando conclusión…" in #conclusion-body.
 * Replaces any previous content.
 */
function setConclusionLoading() {
  clearConclusionBody();
  if (!conclusionBody) return;

  const row = document.createElement("div");
  row.className = "conclusion-loading-row";

  const spinner = document.createElement("div");
  spinner.className = "spinner";
  row.appendChild(spinner);

  const label = document.createElement("span");
  label.className = "conclusion-loading-text";
  label.textContent = "Generando conclusión…";
  row.appendChild(label);

  conclusionBody.appendChild(row);
}

/** Renders the AI conclusion text (plain textContent — untrusted data). */
function setConclusionText(text) {
  clearConclusionBody();
  if (!conclusionBody) return;
  const el = document.createElement("div");
  el.className = "conclusion-ai-text";
  el.textContent = text;
  conclusionBody.appendChild(el);
}

/** Renders an error message in #conclusion-body. */
function setConclusionError(message) {
  clearConclusionBody();
  if (!conclusionBody) return;
  const el = document.createElement("div");
  el.className = "conclusion-error-text";
  el.textContent = message;
  conclusionBody.appendChild(el);
}

/**
 * Shows the "no claims yet" notice in the conclusion view (skips the AI call).
 * Clears stats and sets a neutral notice in the body.
 */
function setConclusionEmpty() {
  // No GENERATE_CONCLUSION was sent, so no result should ever arrive.
  conclusionExpected = false;
  if (conclusionStats) conclusionStats.textContent = "";
  clearConclusionBody();
  if (!conclusionBody) return;
  const notice = document.createElement("div");
  notice.className = "conclusion-notice";
  notice.textContent = "Aún no hay afirmaciones en esta sesión.";
  conclusionBody.appendChild(notice);
}

/**
 * Resets the conclusion view to a blank state (called on tab switch / clear).
 * Does NOT change the current view.
 */
function resetConclusionView() {
  // Any in-flight or already-shown result is no longer relevant after a reset.
  conclusionExpected    = false;
  conclusionResultShown = false;
  if (conclusionStats) conclusionStats.textContent = "";
  clearConclusionBody();
}

// ---------------------------------------------------------------------------
// History view helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Spanish label for an analysis mode.
 * @param {"text"|"audio"|"mic"|null|undefined} mode
 * @returns {string}
 */
function historyModeLabel(mode) {
  if (mode === "audio") return "Análisis de audio";
  if (mode === "mic")   return "Análisis de micrófono";
  return "Análisis de texto";
}

/**
 * Populates the expandable detail section of a history analysis entry.
 * Renders full claim cards (same as VIEW A) for each claim.
 * @param {HTMLElement} container
 * @param {object} entry  History entry of kind "analysis"
 */
function populateAnalysisDetail(container, entry) {
  const claims = entry.claims ?? [];
  if (claims.length === 0) {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.textContent = "Sin afirmaciones.";
    container.appendChild(el);
    return;
  }
  for (const claim of claims) {
    container.appendChild(createClaimCard(claim));
  }
}

/**
 * Populates the expandable detail section of a history conclusion entry.
 * Renders a stats tally + full AI text.
 * @param {HTMLElement} container
 * @param {object} entry  History entry of kind "conclusion"
 */
function populateConclusionDetail(container, entry) {
  const statsEl = document.createElement("div");
  statsEl.className = "conclusion-stats";
  renderStatsInto(statsEl, computeVerdictStats(entry.claims ?? []));
  container.appendChild(statsEl);

  const textEl = document.createElement("div");
  textEl.className = "conclusion-ai-text";
  textEl.textContent = entry.text ?? "";
  container.appendChild(textEl);
}

/**
 * Builds a history row element for a single history entry.
 * Clicking the summary row toggles an inline expandable detail section.
 * @param {object} entry  A history entry from background state
 * @returns {HTMLElement}
 */
function createHistoryRow(entry) {
  const row = document.createElement("div");
  row.className = "history-row";

  // Clickable summary section
  const summary = document.createElement("div");
  summary.className = "history-summary";

  // Meta line: timestamp + type label
  const metaRow = document.createElement("div");
  metaRow.className = "history-meta";

  const timeEl = document.createElement("span");
  timeEl.className = "history-time";
  timeEl.textContent = new Date(entry.ts).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  });
  metaRow.appendChild(timeEl);

  const typeEl = document.createElement("span");
  typeEl.className = "history-type";
  typeEl.textContent = entry.kind === "conclusion"
    ? "Conclusión"
    : historyModeLabel(entry.mode);
  metaRow.appendChild(typeEl);

  summary.appendChild(metaRow);

  // Short summary snippet
  const snippetEl = document.createElement("div");
  snippetEl.className = "history-snippet";
  if (entry.kind === "conclusion") {
    snippetEl.textContent = (entry.text ?? "").slice(0, 120);
  } else {
    const ui = VERDICT_UI[entry.overall?.verdict] ?? VERDICT_UI.unverifiable;
    const count = (entry.claims ?? []).length;
    snippetEl.textContent = `${ui.label} · ${count} afirmación${count !== 1 ? "es" : ""}`;
  }
  summary.appendChild(snippetEl);

  row.appendChild(summary);

  // Expandable detail (hidden by default)
  const detail = document.createElement("div");
  detail.className = "history-detail";
  detail.hidden = true;
  row.appendChild(detail);

  // Toggle expand / collapse on click
  summary.addEventListener("click", () => {
    if (!detail.hidden) {
      detail.hidden = true;
      detail.textContent = "";
      row.classList.remove("history-row--expanded");
    } else {
      detail.textContent = "";
      if (entry.kind === "conclusion") {
        populateConclusionDetail(detail, entry);
      } else {
        populateAnalysisDetail(detail, entry);
      }
      detail.hidden = false;
      row.classList.add("history-row--expanded");
    }
  });

  return row;
}

/**
 * Renders history entries into #history-list, newest first.
 * Clears any previous content. Shows an empty-state notice if the list is empty.
 * @param {Array} entries
 */
function renderHistoryEntries(entries) {
  if (!historyList) return;
  historyList.textContent = "";

  if (!Array.isArray(entries) || entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aún no hay respuestas en esta sesión.";
    historyList.appendChild(empty);
    return;
  }

  // Render newest first (entries are stored oldest-first in background)
  for (const entry of [...entries].reverse()) {
    historyList.appendChild(createHistoryRow(entry));
  }
}

/** Clears #history-list content. */
function resetHistoryView() {
  if (historyList) historyList.textContent = "";
}

// ---------------------------------------------------------------------------
// Render helpers (VIEW A)
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
    // Accumulate all results (same 60-item cap as handleVerdictUpdate)
    // so the local tally matches the full claim set that summarizeSession uses.
    allClaims = (state.results).flatMap((r) => r.claims ?? []).slice(0, 60);
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

  // Reset views — conclusion and history are per-tab-session
  showView("results");
  resetConclusionView();
  resetHistoryView();
  conclusionPending = false;
  if (btnConclusion) btnConclusion.disabled = false;

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

  if (message.type === "CONCLUSION_RESULT" && message.tabId === activeTabId) {
    // Guard: ignore results that belong to a previous/cleared session.
    // conclusionExpected is only true when GENERATE_CONCLUSION was actually sent
    // for the current session; setConclusionEmpty and resetConclusionView clear it.
    if (!conclusionExpected) return;
    conclusionExpected = false;
    conclusionPending  = false;
    if (btnConclusion) btnConclusion.disabled = false;
    // Recompute local tally from the same claims the AI summarised so the stats
    // chips and the AI paragraph are always consistent.
    if (Array.isArray(message.claims) && message.claims.length > 0) {
      renderConclusionStats(computeVerdictStats(message.claims));
    }
    setConclusionText(message.text ?? "");
    // Mark that a valid conclusion is now rendered in VIEW B so a subsequent
    // Conclusión click can re-show VIEW B without firing another AI call.
    conclusionResultShown = true;
    // Stay in VIEW B so the user reads the conclusion; back button returns to Resultados.
  }

  if (message.type === "CONCLUSION_ERROR" && message.tabId === activeTabId) {
    // Mirror the guard: stale errors from a cleared session must be swallowed.
    if (!conclusionExpected) return;
    conclusionExpected = false;
    conclusionPending  = false;
    if (btnConclusion) btnConclusion.disabled = false;
    setConclusionError(message.message ?? "Error desconocido");
  }
});

// ---------------------------------------------------------------------------
// Clear button — clears panel + asks background to start a fresh session
// ---------------------------------------------------------------------------
btnClear.addEventListener("click", () => {
  allClaims = [];
  renderOverall(null);
  renderClaims();
  statusLine.textContent = "Esperando análisis…";

  // Reset all views to empty state
  showView("results");
  resetConclusionView();
  resetHistoryView();
  conclusionPending = false;
  if (btnConclusion) btnConclusion.disabled = false;

  // Ask background to clear this tab's results + history (fresh session)
  if (activeTabId != null) {
    api.runtime.sendMessage({ type: "CLEAR_SESSION", tabId: activeTabId }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Conclusion button — switches to VIEW B and triggers generation
// ---------------------------------------------------------------------------
btnConclusion?.addEventListener("click", () => {
  // Guard against double-clicks while an AI call is already in flight.
  if (conclusionPending) return;

  // If a valid conclusion is already rendered in VIEW B (result arrived while the
  // user was on Resultados or Historial), re-show it without another API call.
  if (conclusionResultShown) {
    showView("conclusion");
    return;
  }

  showView("conclusion");

  if (allClaims.length === 0) {
    setConclusionEmpty();
    return;
  }

  // Instant local stats (no API call needed).
  renderConclusionStats(computeVerdictStats(allClaims));

  // Show spinner and kick off the AI conclusion.
  setConclusionLoading();
  conclusionPending  = true;
  conclusionExpected = true;
  if (btnConclusion) btnConclusion.disabled = true;

  api.runtime.sendMessage({ type: "GENERATE_CONCLUSION", tabId: activeTabId }).catch(() => {});
});

// ---------------------------------------------------------------------------
// History button — switches to VIEW C and loads history from background
// ---------------------------------------------------------------------------
btnHistory?.addEventListener("click", async () => {
  showView("history");
  resetHistoryView();

  if (activeTabId == null) {
    renderHistoryEntries([]);
    return;
  }

  try {
    const resp = await api.runtime.sendMessage({
      type: "GET_HISTORY",
      tabId: activeTabId,
    });
    renderHistoryEntries(resp?.history ?? []);
  } catch {
    renderHistoryEntries([]);
  }
});

// ---------------------------------------------------------------------------
// Back buttons — return to VIEW A (results)
// Does NOT cancel a pending conclusion: the result will still arrive and
// populate VIEW B. If the user is back on Resultados that's fine.
// ---------------------------------------------------------------------------
btnBackFromConclusion?.addEventListener("click", () => {
  showView("results");
});

btnBackFromHistory?.addEventListener("click", () => {
  showView("results");
});

init();
