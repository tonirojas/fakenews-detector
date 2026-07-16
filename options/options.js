/**
 * options/options.js — ES module
 * Builds the provider select from the PROVIDERS registry, handles base URL,
 * model catalog (with free-text fallback for empty catalogs), and STT fields.
 */

import { TIER_LABELS, getProvider, defaultModelFor } from "../lib/models.js";
import { validateBaseUrl } from "../lib/providers.js";
import { api, supportsAudioCapture } from "../lib/webext.js";
import { initTheme } from "../lib/theme.js";

initTheme(document);

// ---------------------------------------------------------------------------
// Provider optgroup mapping
// ---------------------------------------------------------------------------
const PROVIDER_GROUPS = [
  { label: "Principales",   ids: ["anthropic", "openai", "gemini"] },
  { label: "China",         ids: ["deepseek", "qwen", "kimi", "glm", "minimax"] },
  { label: "Otros / Local", ids: ["grok", "mistral", "groq", "openrouter", "ollama", "custom"] },
];

// Free-text model placeholder per provider when the catalog is empty
const EMPTY_CATALOG_PLACEHOLDER = {
  openrouter: "deepseek/deepseek-chat",
  ollama:     "llama3.2",
  custom:     "gpt-4o-mini",
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const selectProvider   = document.getElementById("select-provider");
const baseurlGroup     = document.getElementById("baseurl-group");
const inputBaseurl     = document.getElementById("input-baseurl");
const baseurlError     = document.getElementById("baseurl-error");
const apikeyGroup      = document.getElementById("apikey-group");
const inputApiKey      = document.getElementById("input-apikey");
const apikeyHint       = document.getElementById("apikey-hint");
const selectModel      = document.getElementById("select-model");
const customModelGroup = document.getElementById("custom-model-group");
const inputModelCustom = document.getElementById("input-model-custom");
const modelHint        = document.getElementById("model-hint");
const sttGroup         = document.getElementById("stt-group");
const inputSttKey      = document.getElementById("input-stt-key");
const inputSttBaseurl  = document.getElementById("input-stt-baseurl");
const sttBaseurlError  = document.getElementById("stt-baseurl-error");
const inputSttModel    = document.getElementById("input-stt-model");
const inputInterval    = document.getElementById("input-interval");
const btnSave          = document.getElementById("btn-save");
const confirmMsg       = document.getElementById("confirm-msg");
const selectTheme      = document.getElementById("select-theme");

const CUSTOM_VALUE = "__custom__";

/** Cache the persisted model per provider so switching back restores it. */
const storedModelByProvider = {};

// ---------------------------------------------------------------------------
// Build provider <select> with <optgroup> sections (done once at startup)
// ---------------------------------------------------------------------------
function buildProviderSelect() {
  while (selectProvider.firstChild) selectProvider.removeChild(selectProvider.firstChild);

  for (const group of PROVIDER_GROUPS) {
    const og = document.createElement("optgroup");
    og.label = group.label;
    for (const id of group.ids) {
      const p = getProvider(id);
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      og.appendChild(opt);
    }
    selectProvider.appendChild(og);
  }
}

buildProviderSelect();

// ---------------------------------------------------------------------------
// Model select helpers
// ---------------------------------------------------------------------------
function updateModelHint() {
  if (selectModel.style.display === "none") {
    modelHint.textContent = "Introduce el ID exacto del modelo tal como lo indica el proveedor.";
  } else if (selectModel.value === CUSTOM_VALUE) {
    modelHint.textContent = "Introduce el ID exacto del modelo tal como lo indica el proveedor.";
  } else {
    modelHint.textContent = "Selecciona la velocidad y coste preferidos.";
  }
}

/**
 * Rebuild the model <select> for a given provider.
 *
 * Empty-catalog providers (openrouter, ollama, custom): hide the <select>
 * and show the free-text input directly so the user always sees the entry field.
 *
 * Providers with a catalog: standard behavior — catalog options + "Otro…" fallback.
 * If storedModel is in the catalog it is pre-selected.
 * If storedModel is not in the catalog, "Otro…" is selected with stored value in text input.
 * If storedModel is null/undefined, the recommended fast model is pre-selected.
 *
 * @param {string} providerId
 * @param {string|null|undefined} [storedModel]
 */
function rebuildModelSelect(providerId, storedModel) {
  const provider = getProvider(providerId);
  const catalog  = provider.models ?? [];

  // Remove all existing options
  while (selectModel.firstChild) selectModel.removeChild(selectModel.firstChild);

  if (catalog.length === 0) {
    // Empty catalog — hide select, show free-text input directly
    selectModel.style.display = "none";
    customModelGroup.style.display = "";
    const ph = EMPTY_CATALOG_PLACEHOLDER[providerId] ?? "nombre-del-modelo";
    inputModelCustom.placeholder = ph;
    inputModelCustom.value = storedModel ?? "";
    updateModelHint();
    return;
  }

  // Restore normal select visibility
  selectModel.style.display = "";

  for (const m of catalog) {
    const opt = document.createElement("option");
    opt.value = m.id;
    const tierText = TIER_LABELS[m.tier] ?? m.tier;
    opt.textContent = `${m.label} — ${tierText}`;
    selectModel.appendChild(opt);
  }

  // "Custom" fallback option (always last for catalog providers)
  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_VALUE;
  customOpt.textContent = "Otro (personalizado)…";
  selectModel.appendChild(customOpt);

  const inCatalog = storedModel && catalog.some((m) => m.id === storedModel);

  if (inCatalog) {
    selectModel.value = storedModel;
    customModelGroup.style.display = "none";
    inputModelCustom.value = "";
    inputModelCustom.placeholder = "ID del modelo personalizado";
  } else if (storedModel) {
    selectModel.value = CUSTOM_VALUE;
    inputModelCustom.value = storedModel;
    customModelGroup.style.display = "";
    inputModelCustom.placeholder = "ID del modelo personalizado";
  } else {
    const rec = catalog.find((m) => m.recommended);
    selectModel.value = rec?.id ?? catalog[0]?.id ?? CUSTOM_VALUE;
    customModelGroup.style.display = "none";
    inputModelCustom.value = "";
    inputModelCustom.placeholder = "ID del modelo personalizado";
  }

  updateModelHint();
}

// Show/hide custom text input when model select changes (catalog providers only)
selectModel.addEventListener("change", () => {
  if (selectModel.value === CUSTOM_VALUE) {
    customModelGroup.style.display = "";
    inputModelCustom.focus();
  } else {
    customModelGroup.style.display = "none";
    inputModelCustom.value = "";
  }
  updateModelHint();
});

// ---------------------------------------------------------------------------
// Provider change — rebuild model list, set base URL, toggle UI sections
// ---------------------------------------------------------------------------
function applyProviderUI(providerId) {
  const provider = getProvider(providerId);

  // Rebuild model select
  rebuildModelSelect(providerId, storedModelByProvider[providerId] ?? null);

  // Base URL placeholder = preset URL (may be null for custom)
  inputBaseurl.placeholder = provider.baseUrl ?? "https://…/v1";
  // Highlight required state for custom provider
  if (provider.isCustom) {
    inputBaseurl.classList.add("input-required");
  } else {
    inputBaseurl.classList.remove("input-required");
  }
  // Clear any stale error
  baseurlError.style.display = "none";
  baseurlError.textContent = "";

  // API key section
  if (provider.requiresKey === false) {
    apikeyHint.textContent = "Ollama local no requiere clave de API.";
    inputApiKey.removeAttribute("required");
    inputApiKey.placeholder = "(sin clave)";
  } else {
    apikeyHint.textContent =
      "La clave se guarda localmente y nunca se envía a servidores de esta extensión.";
    inputApiKey.placeholder = "sk-ant-…  /  sk-…  /  AIza…";
  }

  // STT group: always visible — OpenAI provider users may also configure a custom STT endpoint.
  sttGroup.style.display = "";
}

selectProvider.addEventListener("change", () => {
  inputBaseurl.value = ""; // clear stale override from previous provider
  applyProviderUI(selectProvider.value);
});

// ---------------------------------------------------------------------------
// Load saved settings
// ---------------------------------------------------------------------------
async function loadSettings() {
  const keys = [
    "provider", "apiKey", "model", "baseUrl",
    "sttKey", "sttBaseUrl", "sttModel",
    "openaiSttKey",  // legacy — read for migration
    "checkIntervalSec", "theme",
  ];
  const data = await api.storage.local.get(keys);

  const provider = data.provider ?? "anthropic";
  selectProvider.value = provider;

  inputApiKey.value   = data.apiKey ?? "";
  inputInterval.value = String(data.checkIntervalSec ?? 12);
  selectTheme.value   = data.theme ?? "auto";

  // Base URL override (empty string = use preset)
  inputBaseurl.value = data.baseUrl ?? "";

  // STT fields — migrate legacy openaiSttKey → sttKey
  const sttKey = data.sttKey || data.openaiSttKey || "";
  inputSttKey.value     = sttKey;
  inputSttBaseurl.value = data.sttBaseUrl ?? "";
  inputSttModel.value   = data.sttModel ?? "";

  // Cache the stored model for this provider
  storedModelByProvider[provider] = data.model || null;

  // Apply provider-specific UI (rebuilds model select, sets placeholder, toggles sections)
  applyProviderUI(provider);
}

// ---------------------------------------------------------------------------
// Save settings — never log keys
// ---------------------------------------------------------------------------
btnSave.addEventListener("click", async () => {
  const provider     = selectProvider.value;
  const providerInfo = getProvider(provider);

  // Validate base URL if the user typed one
  const rawBaseUrl = inputBaseurl.value.trim();
  if (rawBaseUrl) {
    const urlErr = validateBaseUrl(rawBaseUrl);
    if (urlErr) {
      baseurlError.textContent = urlErr;
      baseurlError.style.display = "";
      inputBaseurl.focus();
      return;
    }
  }
  // Custom provider requires a non-empty base URL
  if (providerInfo.isCustom && !rawBaseUrl) {
    baseurlError.textContent = "El proveedor personalizado requiere una URL base.";
    baseurlError.style.display = "";
    inputBaseurl.focus();
    return;
  }
  baseurlError.style.display = "none";

  // Validate STT base URL if the user typed one
  const rawSttBaseUrl = inputSttBaseurl.value.trim();
  if (rawSttBaseUrl) {
    const sttUrlErr = validateBaseUrl(rawSttBaseUrl);
    if (sttUrlErr) {
      sttBaseurlError.textContent = sttUrlErr;
      sttBaseurlError.style.display = "";
      inputSttBaseurl.focus();
      return;
    }
  }
  sttBaseurlError.style.display = "none";

  // Resolve model
  const catalog = providerInfo.models ?? [];
  let model;
  if (catalog.length === 0) {
    // Free-text provider
    model = inputModelCustom.value.trim() || "";
  } else if (selectModel.value === CUSTOM_VALUE) {
    model = inputModelCustom.value.trim() || defaultModelFor(provider);
  } else {
    model = selectModel.value || defaultModelFor(provider);
  }

  // Cache the chosen model so switching providers and back restores it
  storedModelByProvider[provider] = model;

  const interval = Math.max(5, Math.min(300, parseInt(inputInterval.value, 10) || 12));

  await api.storage.local.set({
    provider,
    apiKey:           inputApiKey.value,     // stored as-is, never logged
    model,
    baseUrl:          rawBaseUrl,
    sttKey:           inputSttKey.value,
    sttBaseUrl:       rawSttBaseUrl,
    sttModel:         inputSttModel.value.trim(),
    checkIntervalSec: interval,
    language:         "es",
    theme:            selectTheme.value,
  });

  // Remove legacy storage key (migrated to sttKey)
  api.storage.local.remove(["openaiSttKey"]).catch(() => {});

  confirmMsg.classList.add("visible");
  setTimeout(() => confirmMsg.classList.remove("visible"), 2200);
});

loadSettings();

// Keep theme dropdown in sync with popup toggle changes
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.theme) {
    selectTheme.value = changes.theme.newValue ?? "auto";
  }
});

// ---------------------------------------------------------------------------
// Microphone permission section (Chrome / Edge only)
// ---------------------------------------------------------------------------
const micPermissionSection = document.getElementById("mic-permission-section");
const btnGrantMic          = document.getElementById("btn-grant-mic");
const micPermStatus        = document.getElementById("mic-perm-status");

if (!supportsAudioCapture()) {
  // Firefox: hide the section and show a note instead
  if (micPermissionSection) {
    const note = document.createElement("p");
    note.className = "hint";
    note.style.marginBottom = "0";
    note.textContent =
      "El modo micrófono (vigilante) no está disponible en Firefox — " +
      "solo Chrome y Edge admiten la captura de audio.";
    micPermissionSection.innerHTML = "";
    const title = document.createElement("h2");
    title.className = "section-title";
    title.textContent = "Micrófono (modo vigilante)";
    micPermissionSection.appendChild(title);
    micPermissionSection.appendChild(note);
  }
} else if (btnGrantMic) {
  btnGrantMic.addEventListener("click", async () => {
    btnGrantMic.disabled = true;
    micPermStatus.textContent = "";
    micPermStatus.className = "mic-perm-status";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Permission granted — stop tracks immediately; we only needed the prompt
      stream.getTracks().forEach((t) => t.stop());
      micPermStatus.textContent =
        "Permiso de micrófono concedido. Ya puedes usar el modo vigilante desde el popup.";
      micPermStatus.className = "mic-perm-status mic-perm-success";
    } catch {
      micPermStatus.textContent =
        "No se pudo obtener el permiso del micrófono (denegado o sin dispositivo).";
      micPermStatus.className = "mic-perm-status mic-perm-error";
    } finally {
      btnGrantMic.disabled = false;
    }
  });
}
