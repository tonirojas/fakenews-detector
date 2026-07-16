/**
 * background.js — MV3 Service Worker (module)
 *
 * Messaging convention: FIRE-AND-FORGET broadcasts (no response expected)
 * are used for VERDICT_UPDATE, ANALYSIS_ERROR, and overlay control messages
 * sent to content scripts and the side panel.
 * Messages that require a reply (GET_STATE, PAGE_TEXT) use sendResponse and
 * return true from the listener to keep the channel open.
 *
 * Message types handled here:
 *   START_TEXT_ANALYSIS  {tabId}
 *   START_AUDIO_ANALYSIS {tabId}
 *   STOP_ANALYSIS        {tabId}
 *   PAGE_TEXT            {tabId, text}
 *   AUDIO_CHUNK          {tabId, base64, mimeType}
 *   GET_STATE            {tabId}                     → responds with state
 */

import { factCheck, transcribe, NoSttError } from "./lib/providers.js";
import { ERRORS } from "./lib/strings.js";
import { defaultModelFor } from "./lib/models.js";

// ---------------------------------------------------------------------------
// Per-tab session state
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} TabState
 * @property {"text"|"audio"|null} mode
 * @property {string[]} transcriptBuffer
 * @property {number} lastCheckTs
 * @property {Array} results         - last AnalysisResult[]
 * @property {boolean} inFlight      - factCheck call pending
 * @property {string|null} lastTextHash
 */

/** @type {Map<number, TabState>} */
const tabStates = new Map();

function defaultState() {
  return {
    mode: null,
    transcriptBuffer: [],
    transcriptHistory: "", // previously flushed (fact-checked) transcript segments
    lastCheckTs: 0,
    results: [],
    inFlight: false,
    lastTextHash: null,
  };
}

function getState(tabId) {
  if (!tabStates.has(tabId)) tabStates.set(tabId, defaultState());
  return tabStates.get(tabId);
}

// Mirror state to session storage so the side panel can recover after SW restarts
async function persistState(tabId) {
  const state = tabStates.get(tabId);
  if (!state) return;
  // Only persist serialisable subset (no functions)
  const { mode, results, lastCheckTs } = state;
  try {
    await chrome.storage.session.set({ [`tabState_${tabId}`]: { mode, results, lastCheckTs } });
  } catch {
    // session storage may not be available in older profiles — ignore
  }
}

// ---------------------------------------------------------------------------
// Auto-mode state
// ---------------------------------------------------------------------------

/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const autoDebounceTimers = new Map(); // tabId → pending setTimeout id

/** @type {Map<string, number>} */
const autoRecentUrls = new Map(); // url → lastAnalyzedAt timestamp (ms)

/** @type {Map<number, string>} */
const tabLastUrl = new Map(); // tabId → last known url (for recency cleanup)

const AUTO_RECENCY_MAX = 50;        // max entries in recency map
const AUTO_RECENCY_MS  = 10 * 60 * 1000; // 10 minutes

// Whether autoRecentUrls has been restored from chrome.storage.session this SW lifetime
let autoRecentUrlsRestored = false;

/**
 * Persist the recency map to chrome.storage.session so it survives MV3 SW restarts
 * within the same browser session.
 */
async function persistAutoRecentUrls() {
  try {
    await chrome.storage.session.set({
      autoRecentUrls: [...autoRecentUrls.entries()],
    });
  } catch {
    // session storage may not be available in older profiles — ignore
  }
}

/**
 * Lazily restore the recency map from chrome.storage.session on the first call
 * after a SW restart. chrome.storage.session is cleared when the browser closes,
 * which matches the desired 10-minute dedup semantics.
 */
async function restoreAutoRecentUrls() {
  if (autoRecentUrlsRestored) return;
  autoRecentUrlsRestored = true;
  try {
    const data = await chrome.storage.session.get(["autoRecentUrls"]);
    const entries = data.autoRecentUrls;
    if (Array.isArray(entries)) {
      for (const [url, ts] of entries) {
        autoRecentUrls.set(url, ts);
      }
    }
  } catch {
    // session storage may not be available — start with an empty map
  }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
async function loadSettings() {
  const defaults = {
    provider: "anthropic",
    apiKey: "",
    model: defaultModelFor("anthropic"),
    openaiSttKey: "",
    checkIntervalSec: 12,
    language: "es",
    autoMode: false,
  };
  const stored = await chrome.storage.local.get(Object.keys(defaults));
  return { ...defaults, ...stored };
}

// ---------------------------------------------------------------------------
// Simple hash for text change detection
// ---------------------------------------------------------------------------
function quickHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return String(h);
}

// ---------------------------------------------------------------------------
// Broadcast helpers (fire-and-forget)
// ---------------------------------------------------------------------------
function broadcastToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // Content script may not be loaded on this tab — ignore
  });
}

function broadcastToRuntime(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open — ignore
  });
}

function broadcastVerdictUpdate(tabId, analysisResult, status) {
  const payload = {
    type: "VERDICT_UPDATE",
    tabId,
    overall: analysisResult.overall,
    claims: analysisResult.claims,
    status: status ?? "ok",
  };
  broadcastToTab(tabId, payload);
  broadcastToRuntime(payload);
  persistState(tabId);
}

function broadcastError(tabId, spanishMessage) {
  const payload = { type: "ANALYSIS_ERROR", tabId, message: spanishMessage };
  broadcastToTab(tabId, payload);
  broadcastToRuntime(payload);
}

// ---------------------------------------------------------------------------
// Offscreen document management
// ---------------------------------------------------------------------------
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen/offscreen.html");

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capture tab audio stream for transcription and fact-checking.",
    });
  }
}

async function closeOffscreenDocument() {
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) await chrome.offscreen.closeDocument();
  } catch {
    // May already be closed
  }
}

// ---------------------------------------------------------------------------
// Text analysis flow
// ---------------------------------------------------------------------------
async function startTextAnalysis(tabId) {
  const state = getState(tabId);
  state.mode = "text";
  // Ask content script to extract text
  try {
    await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_TEXT" });
  } catch {
    broadcastError(tabId, ERRORS.TAB_NOT_FOUND);
  }
}

async function handlePageText(tabId, text) {
  const settings = await loadSettings();
  if (!settings.apiKey) {
    broadcastError(tabId, ERRORS.NO_API_KEY);
    return;
  }

  const state = getState(tabId);
  if (state.mode !== "text") return;

  const now = Date.now();
  const intervalMs = (settings.checkIntervalSec ?? 12) * 1000;
  const hash = quickHash(text);

  if (state.inFlight) return;
  if (hash === state.lastTextHash) return;
  if (now - state.lastCheckTs < intervalMs) return;

  state.inFlight = true;
  state.lastTextHash = hash;
  state.lastCheckTs = now;

  // Stamp URL in recency map now that the content script has delivered text.
  // delete-before-set maintains true LRU insertion order so eviction always
  // removes the genuinely oldest entry.
  try {
    const autoTab = await chrome.tabs.get(tabId);
    const autoUrl = autoTab?.url ?? "";
    if (autoUrl.startsWith("http://") || autoUrl.startsWith("https://")) {
      autoRecentUrls.delete(autoUrl);
      autoRecentUrls.set(autoUrl, now);
      if (autoRecentUrls.size > AUTO_RECENCY_MAX) {
        const oldest = autoRecentUrls.keys().next().value;
        autoRecentUrls.delete(oldest);
      }
      persistAutoRecentUrls(); // fire-and-forget
    }
  } catch {
    // tab may have been closed before page text arrived
  }

  try {
    const result = await factCheck({
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.model || defaultModelFor(settings.provider),
      text,
    });

    state.results.push(result);
    broadcastVerdictUpdate(tabId, result, "ok");
  } catch (err) {
    broadcastError(tabId, `${ERRORS.ANALYSIS_FAILED} (${err.message?.slice(0, 80)})`);
  } finally {
    state.inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Audio analysis flow
// ---------------------------------------------------------------------------
async function startAudioAnalysis(tabId) {
  const state = getState(tabId);
  state.mode = "audio";
  state.transcriptBuffer = [];
  state.transcriptHistory = "";

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    broadcastError(tabId, `No se pudo capturar el audio de la pestaña: ${err.message?.slice(0, 80)}`);
    state.mode = null;
    return;
  }

  try {
    await ensureOffscreenDocument();
    // Await the offscreen response — getUserMedia can fail (permissions, DRM, etc.)
    const response = await chrome.runtime.sendMessage({ type: "OFFSCREEN_START", streamId, tabId });
    if (!response?.ok) {
      throw new Error(response?.error ?? "sin respuesta del documento offscreen");
    }
  } catch (err) {
    state.mode = null;
    broadcastError(
      tabId,
      `No se pudo capturar el audio de la pestaña${err?.message ? ` (${err.message.slice(0, 80)})` : ""}`
    );
    // Close the offscreen document if no other tab is using audio capture
    const otherAudio = [...tabStates.entries()].some(
      ([id, s]) => id !== tabId && s.mode === "audio"
    );
    if (!otherAudio) await closeOffscreenDocument();
  }
}

async function handleAudioChunk(tabId, base64, mimeType) {
  const settings = await loadSettings();

  if (!settings.apiKey) {
    broadcastError(tabId, ERRORS.NO_API_KEY);
    return;
  }

  const state = getState(tabId);
  if (state.mode !== "audio") return;

  // Transcribe chunk
  let transcript;
  try {
    transcript = await transcribe({ settings, base64Audio: base64, mimeType });
  } catch (err) {
    if (err instanceof NoSttError || err.code === "NO_STT") {
      broadcastError(tabId, ERRORS.NO_STT);
    } else {
      broadcastError(tabId, `Error en transcripción: ${err.message?.slice(0, 80)}`);
    }
    return;
  }

  if (!transcript?.trim()) return;

  state.transcriptBuffer.push(transcript);
  const combined = state.transcriptBuffer.join(" ");

  // Fact-check when buffer is large enough and interval has passed
  const now = Date.now();
  const intervalMs = (settings.checkIntervalSec ?? 12) * 1000;
  const shouldCheck =
    (combined.length >= 200 || state.transcriptBuffer.length >= 2) &&
    now - state.lastCheckTs >= intervalMs &&
    !state.inFlight;

  if (!shouldCheck) return;

  state.inFlight = true;
  state.lastCheckTs = now;

  // Use the last ~500 chars of previously flushed transcript as context
  const context = state.transcriptHistory.slice(-500).trim();

  // Snapshot the segment, clear the buffer, and append the segment to history
  const segment = combined;
  state.transcriptBuffer = [];
  state.transcriptHistory = `${state.transcriptHistory} ${segment}`.trim().slice(-4000);

  try {
    const result = await factCheck({
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.model || defaultModelFor(settings.provider),
      text: segment,
      context: context || undefined,
    });

    state.results.push(result);
    broadcastVerdictUpdate(tabId, result, "ok");
  } catch (err) {
    broadcastError(tabId, `${ERRORS.ANALYSIS_FAILED} (${err.message?.slice(0, 80)})`);
  } finally {
    state.inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Stop analysis
// ---------------------------------------------------------------------------
async function stopAnalysis(tabId) {
  const state = tabStates.get(tabId);
  if (!state) return;

  if (state.mode === "audio") {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP", tabId }).catch(() => {});
    // Close offscreen only if no other tab is in audio mode
    const anyAudio = [...tabStates.entries()].some(
      ([id, s]) => id !== tabId && s.mode === "audio"
    );
    if (!anyAudio) await closeOffscreenDocument();
  }

  state.mode = null;
  broadcastToTab(tabId, { type: "REMOVE_OVERLAY" });
  persistState(tabId);
}

// ---------------------------------------------------------------------------
// Auto-mode: schedule + execute
// ---------------------------------------------------------------------------

/**
 * Debounces automatic analysis triggers for the given tab.
 * Clears any pending timer for the tab and restarts a 2500 ms countdown.
 *
 * @param {number} tabId
 */
function scheduleAutoAnalyze(tabId) {
  const prev = autoDebounceTimers.get(tabId);
  if (prev != null) clearTimeout(prev);

  const timer = setTimeout(() => {
    autoDebounceTimers.delete(tabId);
    maybeAutoAnalyze(tabId);
  }, 2500);

  autoDebounceTimers.set(tabId, timer);
}

/**
 * Runs the full set of cost-control guards before starting text analysis.
 * Order of guards (token-cost control):
 *   1. autoMode enabled in settings
 *   2. apiKey configured
 *   3. Tab still exists and is active
 *   4. URL is http:// or https:// (skip chrome://, file://, about:, data:, etc.)
 *   5. Same URL not analyzed in the last 10 minutes (dedupe)
 *   6. No in-flight request; checkIntervalSec not elapsed
 *
 * On pass: reuses the existing text-analysis path (startTextAnalysis).
 * Never auto-starts audio capture.
 *
 * @param {number} tabId
 */
async function maybeAutoAnalyze(tabId) {
  // Restore persisted recency map lazily on the first call after a SW restart
  await restoreAutoRecentUrls();

  // Guard 1 — autoMode enabled
  const settings = await loadSettings();
  if (!settings.autoMode) return;

  // Guard 2 — apiKey configured
  if (!settings.apiKey) return;

  // Guard 3 — tab still exists and is active
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // tab was closed before timer fired
  }
  if (!tab.active) return;

  // Guard 4 — http(s) only
  const url = tab.url ?? "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) return;

  // Guard 5 — recency dedupe
  const now = Date.now();
  const lastAnalyzed = autoRecentUrls.get(url);
  if (lastAnalyzed != null && now - lastAnalyzed < AUTO_RECENCY_MS) return;

  // Guard 6 — no active session, not in-flight, interval elapsed
  const state = getState(tabId);
  if (state.mode !== null) return; // never interrupt a user-started session
  if (state.inFlight) return;
  if (now - state.lastCheckTs < (settings.checkIntervalSec ?? 12) * 1000) return;

  // Reuse the exact existing text-analysis path.
  // autoRecentUrls is stamped inside handlePageText once the content script
  // delivers text, so a failed injection does not block retries for the full
  // 10-minute window.
  await startTextAnalysis(tabId);
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, tabId: msgTabId } = message;

  // Resolve tabId: use explicit field, fall back to sender tab
  const tabId = msgTabId ?? sender?.tab?.id;

  switch (type) {
    case "START_TEXT_ANALYSIS":
      startTextAnalysis(tabId);
      return false; // fire-and-forget

    case "START_AUDIO_ANALYSIS":
      startAudioAnalysis(tabId);
      return false;

    case "STOP_ANALYSIS":
      stopAnalysis(tabId);
      return false;

    case "PAGE_TEXT":
      handlePageText(tabId, message.text);
      return false;

    case "AUDIO_CHUNK":
      handleAudioChunk(tabId, message.base64, message.mimeType);
      return false;

    case "GET_STATE": {
      const state = tabStates.get(tabId);
      if (state) {
        sendResponse({ mode: state.mode, results: state.results, lastCheckTs: state.lastCheckTs });
      } else {
        // Try session storage fallback (SW may have restarted)
        chrome.storage.session
          .get([`tabState_${tabId}`])
          .then((data) => {
            sendResponse(data[`tabState_${tabId}`] ?? null);
          })
          .catch(() => sendResponse(null));
        return true; // keep channel open for async
      }
      return false;
    }

    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Auto-mode tab listeners
// CRITICAL MV3 RULE: registered synchronously at module top level so they
// survive service-worker wake-ups. Settings are read INSIDE the handlers.
// ---------------------------------------------------------------------------
chrome.tabs.onActivated.addListener(({ tabId }) => {
  scheduleAutoAnalyze(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Track the latest URL for recency-map cleanup on tab removal
  if (changeInfo.url) {
    tabLastUrl.set(tabId, changeInfo.url);
  }
  // Only schedule when the tab is active and the page finished loading or URL changed
  if (!tab.active) return;
  if (changeInfo.status === "complete" || changeInfo.url) {
    scheduleAutoAnalyze(tabId);
  }
});

// ---------------------------------------------------------------------------
// Cleanup on tab close
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Clean up auto-mode debounce timer
  const timer = autoDebounceTimers.get(tabId);
  if (timer != null) {
    clearTimeout(timer);
    autoDebounceTimers.delete(tabId);
  }

  // Remove the tab's URL from the recency map so reopening the same URL re-analyzes
  const url = tabLastUrl.get(tabId);
  if (url) {
    autoRecentUrls.delete(url);
    tabLastUrl.delete(tabId);
    persistAutoRecentUrls(); // keep session storage in sync
  }

  const state = tabStates.get(tabId);
  if (state?.mode === "audio") {
    // Stop the recorder and release resources — same path as STOP_ANALYSIS
    chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP", tabId }).catch(() => {});
    const anyAudio = [...tabStates.entries()].some(
      ([id, s]) => id !== tabId && s.mode === "audio"
    );
    if (!anyAudio) await closeOffscreenDocument();
  }
  tabStates.delete(tabId);
  chrome.storage.session.remove([`tabState_${tabId}`]).catch(() => {});
});

// ---------------------------------------------------------------------------
// On install: set default settings
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    const existing = await chrome.storage.local.get(["provider"]);
    if (!existing.provider) {
      await chrome.storage.local.set({
        provider: "anthropic",
        apiKey: "",
        model: defaultModelFor("anthropic"),
        openaiSttKey: "",
        checkIntervalSec: 12,
        language: "es",
        autoMode: false,
      });
    }
  }
});
