/**
 * popup/popup.js
 * Runs in the popup context — short-lived, no persistent state.
 */

const PROVIDER_NAMES = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google Gemini",
};

// UI references
const providerLine = document.getElementById("provider-line");
const statusBox    = document.getElementById("status-box");
const noKeyNotice  = document.getElementById("no-key-notice");
const btnText      = document.getElementById("btn-text");
const btnAudio     = document.getElementById("btn-audio");
const btnStop      = document.getElementById("btn-stop");
const btnPanel     = document.getElementById("btn-panel");
const linkOptions  = document.getElementById("link-options");

let activeTabId = null;
let currentMode = null;

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
// Init
// ---------------------------------------------------------------------------
async function init() {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { setStatus("No se pudo obtener la pestaña activa.", "error"); return; }
  activeTabId = tab.id;

  // Load settings
  const settings = await chrome.storage.local.get(["provider", "apiKey", "model"]);
  const provider  = settings.provider ?? "anthropic";
  const hasKey    = !!settings.apiKey;

  providerLine.textContent = `Proveedor: ${PROVIDER_NAMES[provider] ?? provider}`;

  if (!hasKey) {
    noKeyNotice.style.display = "";
    setButtonsDisabled(true);
  }

  // Get current tab state from background
  chrome.runtime.sendMessage({ type: "GET_STATE", tabId: activeTabId }, (state) => {
    if (chrome.runtime.lastError) return; // SW may have restarted
    currentMode = state?.mode ?? null;
    if (currentMode) {
      showAnalyzing(currentMode);
    } else {
      showStopped();
    }
  });
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
btnText.addEventListener("click", async () => {
  if (!activeTabId) return;
  chrome.runtime.sendMessage({ type: "START_TEXT_ANALYSIS", tabId: activeTabId });
  currentMode = "text";
  showAnalyzing("text");
});

btnAudio.addEventListener("click", async () => {
  if (!activeTabId) return;
  chrome.runtime.sendMessage({ type: "START_AUDIO_ANALYSIS", tabId: activeTabId });
  currentMode = "audio";
  showAnalyzing("audio");
});

btnStop.addEventListener("click", () => {
  if (!activeTabId) return;
  chrome.runtime.sendMessage({ type: "STOP_ANALYSIS", tabId: activeTabId });
  currentMode = null;
  showStopped();
});

// sidePanel.open MUST be called directly inside a click handler (user gesture required)
btnPanel.addEventListener("click", async () => {
  if (!activeTabId) return;
  try {
    await chrome.sidePanel.open({ tabId: activeTabId });
  } catch (err) {
    setStatus(`Error al abrir el panel: ${err.message?.slice(0, 60)}`, "error");
  }
});

linkOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// Listen for updates while popup is open
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
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
