/**
 * popup/popup.js — ES module
 * Runs in the popup context — short-lived, no persistent state.
 */

import { api, supportsAudioCapture, openResultsPanel } from "../lib/webext.js";
import { initTheme, applyTheme } from "../lib/theme.js";
import { getProvider } from "../lib/models.js";
import { DONATION_URL, DONATION_LABEL } from "../lib/strings.js";

// Apply theme as early as possible to minimise flash of wrong theme
initTheme(document);

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
const btnMic         = document.getElementById("btn-mic");
const micHint        = document.getElementById("mic-hint");
const btnStop        = document.getElementById("btn-stop");
const btnPanel       = document.getElementById("btn-panel");
const btnTheme       = document.getElementById("btn-theme");
const linkOptions    = document.getElementById("link-options");
const toggleAutoMode = document.getElementById("toggle-auto-mode");
const donateChip     = document.getElementById("donate-chip");

// Wire donation chip (href + label from single source in lib/strings.js)
if (donateChip) {
  donateChip.href        = DONATION_URL;
  donateChip.querySelector("span").textContent = DONATION_LABEL;
}

let activeTabId      = null;
let currentMode      = null;
let hasKey           = false;            // set in init(); used by toggle handler
let currentProvider  = "anthropic";     // set in init(); used by toggle handler

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setStatus(text, cssClass) {
  statusBox.textContent = text;
  statusBox.className = "status-box" + (cssClass ? ` ${cssClass}` : "");
}

function showAnalyzing(mode) {
  const labels = { audio: "audio/vídeo", text: "texto", mic: "micrófono" };
  const label = labels[mode] ?? "texto";
  setStatus(`Analizando ${label}…`, "analyzing");
  btnText.style.display  = "none";
  btnAudio.style.display = "none";
  if (btnMic) btnMic.style.display = "none";
  btnStop.style.display  = "";
}

function showStopped() {
  setStatus("Detenido");
  btnText.style.display  = "";
  btnAudio.style.display = "";
  if (btnMic) btnMic.style.display = "";
  btnStop.style.display  = "none";
}

function setButtonsDisabled(disabled) {
  btnText.disabled  = disabled;
  btnAudio.disabled = disabled;
  if (btnMic) btnMic.disabled = disabled;
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
    // Mic capture also requires the offscreen API — disable on Firefox
    if (btnMic) btnMic.disabled = true;
    if (micHint) micHint.textContent = AUDIO_CAPTURE_UNSUPPORTED;
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
  currentProvider = provider;
  hasKey          = !!settings.apiKey;

  toggleAutoMode.checked = !!settings.autoMode;

  providerLine.textContent = `Proveedor: ${getProvider(provider).label}`;

  // Show no-key notice only when the provider actually requires a key
  const provInfo = getProvider(provider);
  if (provInfo.requiresKey !== false && !hasKey) {
    noKeyNotice.style.display = "";
    setButtonsDisabled(true); // disables text, audio, and mic buttons
    btnAudio.disabled = true; // ensure audio stays disabled even if already enabled above
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

// Mic capture: the permission prompt lives in Options (stable tab context).
// Here we just send the start message — the offscreen doc opens its own getUserMedia.
// If permission was never granted, background.js surfaces a Spanish error pointing
// the user to Configuración → Micrófono.
if (btnMic) {
  btnMic.addEventListener("click", () => {
    if (!activeTabId) return;
    if (!supportsAudioCapture()) return; // button already disabled on Firefox
    api.runtime.sendMessage({ type: "START_MIC_ANALYSIS", tabId: activeTabId }).catch(() => {});
    currentMode = "mic";
    showAnalyzing("mic");
  });
}

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
    // Skip only when the active provider actually requires a key and none is configured
    const provInfoToggle = getProvider(currentProvider);
    if (provInfoToggle.requiresKey !== false && !hasKey) return;
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
