/**
 * popup/popup.js — ES module
 * Runs in the popup context — short-lived, no persistent state.
 */

import { api, supportsAudioCapture, openResultsPanel } from "../lib/webext.js";
import { initTheme, applyTheme } from "../lib/theme.js";

// Apply theme as early as possible to minimise flash of wrong theme
initTheme(document);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROVIDER_NAMES = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google Gemini",
};

// Spanish message for unsupported audio capture (must match background.js)
const AUDIO_CAPTURE_UNSUPPORTED =
  "La captura de audio solo está disponible en Chrome y Edge.";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const providerLine   = document.getElementById("provider-line");
const statusBox      = document.getElementById("status-box");
const noKeyNotice    = document.getElementById("no-key-notice");
const btnText        = document.getElementById("btn-text");
const btnAudio       = document.getElementById("btn-audio");
const audioHint      = document.getElementById("audio-hint");
const btnStop        = document.getElementById("btn-stop");
const btnPanel       = document.getElementById("btn-panel");
const btnTheme       = document.getElementById("btn-theme");
const linkOptions    = document.getElementById("link-options");
const toggleAutoMode = document.getElementById("toggle-auto-mode");

let activeTabId = null;
let currentMode = null;
let hasKey = false; // set in init(); used by toggle handler

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setStatus(text, cssClass) {
  statusBox.textContent = text;
  statusBox.className = "status-box" + (cssClass ? ` ${cssClass}` : "");
}

function showAnalyzing(mode) {
  const label = mode === "audio" ? "audio/vídeo" : "texto";
  setStatus(`Analizando ${label}…`, "analyzing");
  btnText.style.display  = "none";
  btnAudio.style.display = "none";
  btnStop.style.display  = "";
}

function showStopped() {
  setStatus("Detenido");
  btnText.style.display  = "";
  btnAudio.style.display = "";
  btnStop.style.display  = "none";
}

function setButtonsDisabled(disabled) {
  btnText.disabled  = disabled;
  btnAudio.disabled = disabled;
}

// ---------------------------------------------------------------------------
// Theme toggle button
// ---------------------------------------------------------------------------
function updateThemeButton(resolvedTheme) {
  if (resolvedTheme === "dark") {
    btnTheme.textContent  = "☀";
    btnTheme.title        = "Modo claro";
    btnTheme.setAttribute("aria-label", "Modo claro");
  } else {
    btnTheme.textContent  = "🌙";
    btnTheme.title        = "Modo oscuro";
    btnTheme.setAttribute("aria-label", "Modo oscuro");
  }
}

function currentResolvedTheme() {
  return document.documentElement.getAttribute("data-theme") ?? "light";
}

// Sync button icon with the data-theme attribute whenever it changes
// (covers live storage changes handled by initTheme)
new MutationObserver(() => {
  updateThemeButton(currentResolvedTheme());
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

btnTheme.addEventListener("click", async () => {
  const { theme: stored } = await api.storage.local.get(["theme"]);
  const resolved = currentResolvedTheme(); // "light" | "dark" — already resolved by initTheme
  // Clicking always commits to an explicit value; if the stored setting was "auto"
  // (OS-follow), it is intentionally replaced by the user's explicit choice here.
  const next = resolved === "dark" ? "light" : "dark";
  await api.storage.local.set({ theme: next });
  applyTheme(document, next);
  updateThemeButton(next);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  // Apply initial theme button state (data-theme may already be set by initTheme)
  updateThemeButton(currentResolvedTheme());

  // Handle browsers that do not support audio capture (Firefox)
  if (!supportsAudioCapture()) {
    btnAudio.disabled        = true;
    audioHint.style.display  = "";
    audioHint.textContent    = AUDIO_CAPTURE_UNSUPPORTED;
  }

  // Get active tab
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) { setStatus("No se pudo obtener la pestaña activa.", "error"); return; }
  activeTabId = tab.id;

  // Load settings
  const settings = await api.storage.local.get([
    "provider", "apiKey", "model", "autoMode",
  ]);
  const provider  = settings.provider ?? "anthropic";
  hasKey          = !!settings.apiKey;

  toggleAutoMode.checked = !!settings.autoMode;

  providerLine.textContent = `Proveedor: ${PROVIDER_NAMES[provider] ?? provider}`;

  if (!hasKey) {
    noKeyNotice.style.display = "";
    setButtonsDisabled(true);
    // Re-disable audio if it was enabled by supportsAudioCapture
    btnAudio.disabled = true;
  }

  // Get current tab state from background
  api.runtime.sendMessage({ type: "GET_STATE", tabId: activeTabId })
    .then((state) => {
      currentMode = state?.mode ?? null;
      if (currentMode) {
        showAnalyzing(currentMode);
      } else {
        showStopped();
      }
    })
    .catch(() => {
      // Service worker may have restarted
      showStopped();
    });
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
btnText.addEventListener("click", () => {
  if (!activeTabId) return;
  api.runtime.sendMessage({ type: "START_TEXT_ANALYSIS", tabId: activeTabId }).catch(() => {});
  currentMode = "text";
  showAnalyzing("text");
});

btnAudio.addEventListener("click", () => {
  if (!activeTabId) return;
  api.runtime.sendMessage({ type: "START_AUDIO_ANALYSIS", tabId: activeTabId }).catch(() => {});
  currentMode = "audio";
  showAnalyzing("audio");
});

btnStop.addEventListener("click", () => {
  if (!activeTabId) return;
  api.runtime.sendMessage({ type: "STOP_ANALYSIS", tabId: activeTabId }).catch(() => {});
  currentMode = null;
  showStopped();
});

// Auto-mode toggle
toggleAutoMode.addEventListener("change", async () => {
  const enabled = toggleAutoMode.checked;
  try {
    await api.storage.local.set({ autoMode: enabled });
  } catch {
    // storage unavailable — ignore
  }

  // Toggling ON: immediately start analysis of the current tab (if idle)
  if (enabled && activeTabId && currentMode === null) {
    if (!hasKey) return; // no API key configured — skip
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith("http")) return; // non-http URL — skip
    api.runtime.sendMessage({ type: "START_TEXT_ANALYSIS", tabId: activeTabId }).catch(() => {});
    currentMode = "text";
    showAnalyzing("text");
  }
  // Toggling OFF: persist only — do not disturb any running analysis
});

// openResultsPanel MUST be called directly inside the click handler (user gesture required)
btnPanel.addEventListener("click", async () => {
  if (!activeTabId) return;
  try {
    await openResultsPanel(activeTabId);
  } catch (err) {
    setStatus(`Error al abrir el panel: ${err.message?.slice(0, 60)}`, "error");
  }
});

linkOptions.addEventListener("click", (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// Listen for updates while popup is open
// ---------------------------------------------------------------------------
api.runtime.onMessage.addListener((message) => {
  if (message.tabId !== activeTabId) return;

  if (message.type === "VERDICT_UPDATE") {
    const v = message.overall?.verdict;
    const labels = {
      true: "Lo que dice es verdad",
      uncertain: "Peligro, podría estar mintiendo",
      false: "Peligro, FAKE NEW confirmada",
      unverifiable: "Sin datos suficientes para verificar",
    };
    setStatus(labels[v] ?? "Análisis completado");
  }

  if (message.type === "ANALYSIS_ERROR") {
    setStatus(message.message ?? "Error desconocido", "error");
    showStopped();
  }
});

init();
