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
 *   START_MIC_ANALYSIS   {tabId}
 *   STOP_ANALYSIS        {tabId}
 *   PAGE_TEXT            {tabId, text}
 *   AUDIO_CHUNK          {tabId, base64, mimeType}
 *   GET_STATE            {tabId}                     → responds with state
 */

import { factCheck, transcribe, summarizeSession, NoSttError } from "./lib/providers.js";
import { ERRORS } from "./lib/strings.js";
import { defaultModelFor, getProvider } from "./lib/models.js";
import { api, supportsAudioCapture } from "./lib/webext.js";

// ---------------------------------------------------------------------------
// Per-tab session state
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} TabState
 * @property {"text"|"audio"|"mic"|null} mode
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
    conclusionInFlight: false,
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
    await api.storage.session.set({ [`tabState_${tabId}`]: { mode, results, lastCheckTs } });
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

// Whether autoRecentUrls has been restored from api.storage.session this SW lifetime
let autoRecentUrlsRestored = false;

/**
 * Persist the recency map to api.storage.session so it survives MV3 SW restarts
 * within the same browser session.
 */
async function persistAutoRecentUrls() {
  try {
    await api.storage.session.set({
      autoRecentUrls: [...autoRecentUrls.entries()],
    });
  } catch {
    // session storage may not be available in older profiles — ignore
  }
}

/**
 * Lazily restore the recency map from api.storage.session on the first call
 * after a SW restart. api.storage.session is cleared when the browser closes,
 * which matches the desired 10-minute dedup semantics.
 */
async function restoreAutoRecentUrls() {
  if (autoRecentUrlsRestored) return;
  autoRecentUrlsRestored = true;
  try {
    const data = await api.storage.session.get(["autoRecentUrls"]);
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
    baseUrl: "",
    sttKey: "",
    sttBaseUrl: "",
    sttModel: "",
    checkIntervalSec: 12,
    language: "es",
    autoMode: false,
    theme: "auto",
  };
  // Read current keys + legacy openaiSttKey for one-time migration
  const stored = await api.storage.local.get([...Object.keys(defaults), "openaiSttKey"]);
  // Migrate openaiSttKey → sttKey (does not write back; write happens on next Save)
  if (!stored.sttKey && stored.openaiSttKey) {
    stored.sttKey = stored.openaiSttKey;
  }
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
  api.tabs.sendMessage(tabId, message).catch(() => {
    // Content script may not be loaded on this tab — ignore
  });
}

function broadcastToRuntime(message) {
  api.runtime.sendMessage(message).catch(() => {
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
// Offscreen document management (Chrome / Edge only)
// Guard all calls behind supportsAudioCapture() — these APIs do not exist in Firefox.
// ---------------------------------------------------------------------------
const OFFSCREEN_URL = api.runtime.getURL("offscreen/offscreen.html");

async function ensureOffscreenDocument() {
  const existing = await api.offscreen.hasDocument();
  if (!existing) {
    await api.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [api.offscreen.Reason.USER_MEDIA],
      justification: "Capture tab audio stream for transcription and fact-checking.",
    });
  }
}

async function closeOffscreenDocument() {
  try {
    const exists = await api.offscreen.hasDocument();
    if (exists) await api.offscreen.closeDocument();
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
    await api.tabs.sendMessage(tabId, { type: "EXTRACT_TEXT" });
  } catch {
    broadcastError(tabId, ERRORS.TAB_NOT_FOUND);
  }
}

async function handlePageText(tabId, text) {
  const settings = await loadSettings();
  const provInfo = getProvider(settings.provider);
  if (provInfo.requiresKey !== false && !settings.apiKey) {
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
    const autoTab = await api.tabs.get(tabId);
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
    const model = settings.model || defaultModelFor(settings.provider);
    const result = await factCheck({ ...settings, model }, text);

    state.results.push(result);
    broadcastVerdictUpdate(tabId, result, "ok");
  } catch (err) {
    broadcastError(tabId, `${ERRORS.ANALYSIS_FAILED} (${err.message?.slice(0, 80)})`);
  } finally {
    state.inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Audio analysis flow (Chrome / Edge only)
// ---------------------------------------------------------------------------
async function startAudioAnalysis(tabId) {
  // Guard: tabCapture and offscreen APIs are unavailable on Firefox
  if (!supportsAudioCapture()) {
    broadcastError(tabId, ERRORS.AUDIO_CAPTURE_UNSUPPORTED);
    return;
  }

  const state = getState(tabId);
  state.mode = "audio";
  state.transcriptBuffer = [];
  state.transcriptHistory = "";

  let streamId;
  try {
    streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    broadcastError(tabId, `No se pudo capturar el audio de la pestaña: ${err.message?.slice(0, 80)}`);
    state.mode = null;
    return;
  }

  try {
    await ensureOffscreenDocument();
    // Await the offscreen response — getUserMedia can fail (permissions, DRM, etc.)
    const response = await api.runtime.sendMessage({ type: "OFFSCREEN_START", streamId, tabId });
    if (!response?.ok) {
      throw new Error(response?.error ?? "sin respuesta del documento offscreen");
    }
  } catch (err) {
    state.mode = null;
    broadcastError(
      tabId,
      `No se pudo capturar el audio de la pestaña${err?.message ? ` (${err.message.slice(0, 80)})` : ""}`
    );
    // Close the offscreen document if no other tab is using audio/mic capture
    const otherCapture = [...tabStates.entries()].some(
      ([id, s]) => id !== tabId && (s.mode === "audio" || s.mode === "mic")
    );
    if (!otherCapture) await closeOffscreenDocument();
  }
}

async function handleAudioChunk(tabId, base64, mimeType) {
  const settings = await loadSettings();
  const provInfo = getProvider(settings.provider);
  if (provInfo.requiresKey !== false && !settings.apiKey) {
    broadcastError(tabId, ERRORS.NO_API_KEY);
    return;
  }

  const state = getState(tabId);
  if (state.mode !== "audio" && state.mode !== "mic") return;

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
    const model = settings.model || defaultModelFor(settings.provider);
    const result = await factCheck({ ...settings, model }, segment, context || undefined);

    state.results.push(result);
    broadcastVerdictUpdate(tabId, result, "ok");
  } catch (err) {
    broadcastError(tabId, `${ERRORS.ANALYSIS_FAILED} (${err.message?.slice(0, 80)})`);
  } finally {
    state.inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Microphone analysis flow (Chrome / Edge only)
// ---------------------------------------------------------------------------
async function startMicAnalysis(tabId) {
  // Guard: offscreen/tabCapture APIs are unavailable on Firefox
  if (!supportsAudioCapture()) {
    broadcastError(tabId, ERRORS.AUDIO_CAPTURE_UNSUPPORTED);
    return;
  }

  const state = getState(tabId);
  state.mode = "mic";
  state.transcriptBuffer = [];
  state.transcriptHistory = "";

  try {
    await ensureOffscreenDocument();
    // The offscreen document calls getUserMedia({audio:true}) directly.
    // Permission must have been granted via Configuración → Micrófono first.
    const response = await api.runtime.sendMessage({ type: "OFFSCREEN_START_MIC", tabId });
    if (!response?.ok) {
      throw new Error(response?.error ?? "sin respuesta del documento offscreen");
    }
  } catch {
    state.mode = null;
    // Guide the user to grant mic permission from the Options page (stable context).
    broadcastError(tabId, ERRORS.MIC_PERMISSION_DENIED);
    // Close the offscreen document if no other tab is using audio/mic capture
    const otherCapture = [...tabStates.entries()].some(
      ([id, s]) => id !== tabId && (s.mode === "audio" || s.mode === "mic")
    );
    if (!otherCapture) await closeOffscreenDocument();
  }
}

// ---------------------------------------------------------------------------
// Stop analysis
// ---------------------------------------------------------------------------
async function stopAnalysis(tabId) {
  const state = tabStates.get(tabId);

  // Send OFFSCREEN_STOP only when this tab was actually capturing audio/mic,
  // or when its state is absent after a SW restart (resilience fallback).
  // Sending it unconditionally would tear down an active capture in another tab.
  const stateMode = state?.mode ?? null;
  if (supportsAudioCapture() && (stateMode === "audio" || stateMode === "mic" || stateMode === null)) {
    api.runtime.sendMessage({ type: "OFFSCREEN_STOP", tabId }).catch(() => {});
    const anyCapture = [...tabStates.entries()].some(
      ([id, s]) => id !== tabId && (s.mode === "audio" || s.mode === "mic")
    );
    if (!anyCapture) await closeOffscreenDocument();
  }

  if (state) {
    state.mode = null;
    persistState(tabId);
  }
  broadcastToTab(tabId, { type: "REMOVE_OVERLAY" });
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

  // Guard 2 — apiKey configured (skip for providers that do not require a key, e.g. Ollama)
  const provInfo = getProvider(settings.provider);
  if (provInfo.requiresKey !== false && !settings.apiKey) return;

  // Guard 3 — tab still exists and is active
  let tab;
  try {
    tab = await api.tabs.get(tabId);
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
// Sender validation helper
// ---------------------------------------------------------------------------
/**
 * Returns true when the message came from an extension page (popup, options,
 * sidepanel, offscreen document) — NOT from a content script injected into
 * a web page. Extension pages have sender.id === runtime.id and no sender.tab.
 *
 * @param {chrome.runtime.MessageSender} sender
 */
function isExtensionPageSender(sender) {
  return sender?.id === api.runtime.id && !sender?.tab;
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, tabId: msgTabId } = message;

  // Resolve tabId: use explicit field, fall back to sender tab
  const tabId = msgTabId ?? sender?.tab?.id;

  switch (type) {
    // ── Commands that must only come from extension pages (not content scripts) ──
    case "START_TEXT_ANALYSIS":
      if (!isExtensionPageSender(sender)) return false;
      startTextAnalysis(tabId);
      return false; // fire-and-forget

    case "START_AUDIO_ANALYSIS":
      if (!isExtensionPageSender(sender)) return false;
      startAudioAnalysis(tabId);
      return false;

    case "START_MIC_ANALYSIS":
      if (!isExtensionPageSender(sender)) return false;
      startMicAnalysis(tabId);
      return false;

    case "STOP_ANALYSIS":
      if (!isExtensionPageSender(sender)) return false;
      stopAnalysis(tabId);
      return false;

    // ── Data messages from content scripts and the offscreen document ──
    case "PAGE_TEXT":
      // Sender is a content script (sender.tab is set) — accepted from web pages
      handlePageText(tabId, message.text);
      return false;

    case "AUDIO_CHUNK":
      // Sender is the offscreen document (extension page, no tab)
      if (!isExtensionPageSender(sender)) return false;
      handleAudioChunk(tabId, message.base64, message.mimeType);
      return false;

    case "AUDIO_LEVEL":
      // Relay VU meter readings from the offscreen document to the side panel.
      // Guard with isExtensionPageSender to block spoofing from content scripts.
      if (!isExtensionPageSender(sender)) return false;
      broadcastToRuntime(message);
      return false;

    case "GET_STATE": {
      if (!isExtensionPageSender(sender)) return false;
      const state = tabStates.get(tabId);
      if (state) {
        sendResponse({ mode: state.mode, results: state.results, lastCheckTs: state.lastCheckTs });
      } else {
        // Try session storage fallback (SW may have restarted)
        api.storage.session
          .get([`tabState_${tabId}`])
          .then((data) => {
            sendResponse(data[`tabState_${tabId}`] ?? null);
          })
          .catch(() => sendResponse(null));
        return true; // keep channel open for async
      }
      return false;
    }

    case "GENERATE_CONCLUSION": {
      if (!isExtensionPageSender(sender)) return false;
      // Capture tabId for the async closure (the outer `tabId` binding is stable)
      const gcTabId = tabId;
      (async () => {
        const gcState = getState(gcTabId);

        // Collect all claims across every analysis result for this tab.
        // Fix #3: if in-memory state is empty (SW restarted), fall back to
        // session storage — mirrors the same fallback used by GET_STATE.
        let results = gcState?.results ?? [];
        if (results.length === 0) {
          try {
            const stored = await api.storage.session.get([`tabState_${gcTabId}`]);
            const persisted = stored[`tabState_${gcTabId}`];
            if (persisted?.results?.length) {
              results = persisted.results;
              // Hydrate in-memory state so subsequent calls are fast
              gcState.results = results;
              gcState.mode = persisted.mode ?? gcState.mode;
              gcState.lastCheckTs = persisted.lastCheckTs ?? gcState.lastCheckTs;
            }
          } catch {
            // session storage unavailable — leave results empty
          }
        }

        const claims = results.flatMap((r) => r.claims ?? []);
        if (claims.length === 0) {
          broadcastToRuntime({
            type: "CONCLUSION_ERROR",
            tabId: gcTabId,
            message: "Aún no hay afirmaciones analizadas en esta sesión.",
          });
          return;
        }

        // Per-tab in-flight guard — prevents double-clicks from firing two calls
        // Fix #1: guard is set before loadSettings() so a storage-API rejection
        // inside the try block is caught and broadcast as CONCLUSION_ERROR instead
        // of escaping the IIFE as an unhandled rejection.
        if (gcState.conclusionInFlight) return;
        gcState.conclusionInFlight = true;

        try {
          const settings = await loadSettings();
          const provInfo = getProvider(settings.provider);
          if (provInfo.requiresKey !== false && !settings.apiKey) {
            broadcastToRuntime({
              type: "CONCLUSION_ERROR",
              tabId: gcTabId,
              message: ERRORS.NO_API_KEY,
            });
            return;
          }
          const text = await summarizeSession(settings, claims);
          // Fix #2: include the authoritative claims list so the sidepanel can
          // recompute local stats from the same set the AI summarised.
          broadcastToRuntime({ type: "CONCLUSION_RESULT", tabId: gcTabId, text, claims });
        } catch (err) {
          broadcastToRuntime({
            type: "CONCLUSION_ERROR",
            tabId: gcTabId,
            message: `Error al generar la conclusión (${err.message?.slice(0, 80)})`,
          });
        } finally {
          gcState.conclusionInFlight = false;
        }
      })();
      return false; // fire-and-forget
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
api.tabs.onActivated.addListener(({ tabId }) => {
  scheduleAutoAnalyze(tabId);
});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
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
api.tabs.onRemoved.addListener(async (tabId) => {
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

  // Send OFFSCREEN_STOP only when the closed tab was capturing audio/mic,
  // or when its state is absent after a SW restart (resilience fallback).
  // Sending it unconditionally would tear down an active capture in another tab.
  const removedMode = tabStates.get(tabId)?.mode ?? null;
  if (supportsAudioCapture() && (removedMode === "audio" || removedMode === "mic" || removedMode === null)) {
    api.runtime.sendMessage({ type: "OFFSCREEN_STOP", tabId }).catch(() => {});
    const anyCapture = [...tabStates.entries()].some(
      ([id, s]) => id !== tabId && (s.mode === "audio" || s.mode === "mic")
    );
    if (!anyCapture) await closeOffscreenDocument();
  }
  tabStates.delete(tabId);
  api.storage.session.remove([`tabState_${tabId}`]).catch(() => {});
});

// ---------------------------------------------------------------------------
// On install: set default settings
// ---------------------------------------------------------------------------
api.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    const existing = await api.storage.local.get(["provider"]);
    if (!existing.provider) {
      await api.storage.local.set({
        provider: "anthropic",
        apiKey: "",
        model: defaultModelFor("anthropic"),
        baseUrl: "",
        sttKey: "",
        sttBaseUrl: "",
        sttModel: "",
        checkIntervalSec: 12,
        language: "es",
        autoMode: false,
        theme: "auto",
      });
    }
  }
});
