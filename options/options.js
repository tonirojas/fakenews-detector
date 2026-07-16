/**
 * options/options.js
 */

const PROVIDER_DEFAULTS = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
};

const MODEL_HINTS = {
  anthropic: "Predeterminado para Anthropic: <strong>claude-sonnet-4-5</strong>",
  openai:    "Predeterminado para OpenAI: <strong>gpt-4o-mini</strong>",
  gemini:    "Predeterminado para Google Gemini: <strong>gemini-2.0-flash</strong>",
};

const selectProvider = document.getElementById("select-provider");
const inputApiKey    = document.getElementById("input-apikey");
const inputModel     = document.getElementById("input-model");
const inputSttKey    = document.getElementById("input-stt-key");
const inputInterval  = document.getElementById("input-interval");
const btnSave        = document.getElementById("btn-save");
const confirmMsg     = document.getElementById("confirm-msg");
const modelHint      = document.getElementById("model-hint");
const sttGroup       = document.getElementById("stt-group");

// Update model hint and STT visibility on provider change
selectProvider.addEventListener("change", () => {
  const p = selectProvider.value;
  modelHint.innerHTML = MODEL_HINTS[p] ?? "";
  // Show STT key field only when provider is not openai (openai key covers STT already)
  sttGroup.style.display = p === "openai" ? "none" : "";
});

// Load saved settings
async function loadSettings() {
  const data = await chrome.storage.local.get([
    "provider", "apiKey", "model", "openaiSttKey", "checkIntervalSec",
  ]);

  selectProvider.value  = data.provider ?? "anthropic";
  inputApiKey.value     = data.apiKey ?? "";
  inputModel.value      = data.model ?? "";
  inputSttKey.value     = data.openaiSttKey ?? "";
  inputInterval.value   = data.checkIntervalSec ?? 12;

  // Trigger UI update
  selectProvider.dispatchEvent(new Event("change"));
}

// Save settings (never log keys)
btnSave.addEventListener("click", async () => {
  const provider = selectProvider.value;
  const model    = inputModel.value.trim() || PROVIDER_DEFAULTS[provider];
  const interval = Math.max(5, Math.min(300, parseInt(inputInterval.value, 10) || 12));

  await chrome.storage.local.set({
    provider,
    apiKey:          inputApiKey.value,   // stored as-is, never logged
    model,
    openaiSttKey:    inputSttKey.value,
    checkIntervalSec: interval,
    language: "es",
  });

  // Show confirmation briefly
  confirmMsg.classList.add("visible");
  setTimeout(() => confirmMsg.classList.remove("visible"), 2200);
});

loadSettings();
