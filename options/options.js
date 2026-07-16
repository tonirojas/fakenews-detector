/**
 * options/options.js — ES module
 * Imports MODEL_CATALOG and defaultModelFor from lib/models.js.
 */

import { MODEL_CATALOG, TIER_LABELS, defaultModelFor } from "../lib/models.js";
import { api } from "../lib/webext.js";
import { initTheme } from "../lib/theme.js";

// Apply theme as early as possible to minimise flash of wrong theme
initTheme(document);

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const selectProvider   = document.getElementById("select-provider");
const inputApiKey      = document.getElementById("input-apikey");
const selectModel      = document.getElementById("select-model");
const customModelGroup = document.getElementById("custom-model-group");
const inputModelCustom = document.getElementById("input-model-custom");
const inputSttKey      = document.getElementById("input-stt-key");
const inputInterval    = document.getElementById("input-interval");
const btnSave          = document.getElementById("btn-save");
const confirmMsg       = document.getElementById("confirm-msg");
const modelHint        = document.getElementById("model-hint");
const sttGroup         = document.getElementById("stt-group");
const selectTheme      = document.getElementById("select-theme");

const CUSTOM_VALUE = "__custom__";

/** Caches the persisted model for each provider so switching providers and back restores it. */
const storedModelByProvider = {};

// ---------------------------------------------------------------------------
// Model select helpers
// ---------------------------------------------------------------------------

function updateModelHint() {
  if (selectModel.value === CUSTOM_VALUE) {
    modelHint.textContent = "Introduce el ID exacto del modelo tal como lo indica el proveedor.";
  } else {
    modelHint.textContent = "Selecciona la velocidad y coste preferidos.";
  }
}

/**
 * Rebuild the model <select> for a given provider.
 *
 * If storedModel is in the catalog it is pre-selected.
 * If storedModel is NOT in the catalog the "Otro (personalizado)…" option is
 * selected and the stored value is preserved in the text input — it is never
 * silently overwritten.
 * If storedModel is null/undefined the fast recommended model is pre-selected.
 *
 * @param {string} provider
 * @param {string|null|undefined} [storedModel]
 */
function rebuildModelSelect(provider, storedModel) {
  const catalog = MODEL_CATALOG[provider] ?? [];

  // Remove all existing options without innerHTML
  while (selectModel.firstChild) {
    selectModel.removeChild(selectModel.firstChild);
  }

  // Add one option per catalog entry
  for (const m of catalog) {
    const opt = document.createElement("option");
    opt.value = m.id;
    const tierText = TIER_LABELS[m.tier] ?? m.tier;
    opt.textContent = `${m.label} — ${tierText}`;
    selectModel.appendChild(opt);
  }

  // "Custom" fallback option (always last)
  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_VALUE;
  customOpt.textContent = "Otro (personalizado)…";
  selectModel.appendChild(customOpt);

  const inCatalog = storedModel && catalog.some((m) => m.id === storedModel);

  if (inCatalog) {
    // Stored model is a known catalog entry — select it
    selectModel.value = storedModel;
    customModelGroup.style.display = "none";
    inputModelCustom.value = "";
  } else if (storedModel) {
    // Stored model is custom — never overwrite it; show the custom input
    selectModel.value = CUSTOM_VALUE;
    inputModelCustom.value = storedModel;
    customModelGroup.style.display = "";
  } else {
    // No stored model — default to the recommended fast model for this provider
    const rec = catalog.find((m) => m.recommended);
    selectModel.value = rec?.id ?? catalog[0]?.id ?? CUSTOM_VALUE;
    customModelGroup.style.display = "none";
    inputModelCustom.value = "";
  }

  updateModelHint();
}

// Show/hide custom text input when model select changes
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
// Provider change — rebuild model list + toggle STT group
// ---------------------------------------------------------------------------
selectProvider.addEventListener("change", () => {
  const p = selectProvider.value;
  // Restore the previously saved model for this provider, or fall back to its
  // recommended fast model if the provider was never configured
  rebuildModelSelect(p, storedModelByProvider[p] ?? null);
  sttGroup.style.display = p === "openai" ? "none" : "";
});

// ---------------------------------------------------------------------------
// Load saved settings
// ---------------------------------------------------------------------------
async function loadSettings() {
  const data = await api.storage.local.get([
    "provider", "apiKey", "model", "openaiSttKey", "checkIntervalSec", "theme",
  ]);

  const provider = data.provider ?? "anthropic";
  selectProvider.value = provider;
  inputApiKey.value    = data.apiKey ?? "";
  inputSttKey.value    = data.openaiSttKey ?? "";
  inputInterval.value  = String(data.checkIntervalSec ?? 12);
  selectTheme.value    = data.theme ?? "auto";

  // Cache the stored model for this provider so switching providers and back restores it
  storedModelByProvider[provider] = data.model || null;

  // Rebuild model select honouring the stored model (may be custom)
  rebuildModelSelect(provider, data.model || null);

  // STT group visibility
  sttGroup.style.display = provider === "openai" ? "none" : "";
}

// ---------------------------------------------------------------------------
// Save settings — never log keys
// ---------------------------------------------------------------------------
btnSave.addEventListener("click", async () => {
  const provider = selectProvider.value;

  let model;
  if (selectModel.value === CUSTOM_VALUE) {
    model = inputModelCustom.value.trim() || defaultModelFor(provider);
  } else {
    model = selectModel.value || defaultModelFor(provider);
  }

  const interval = Math.max(5, Math.min(300, parseInt(inputInterval.value, 10) || 12));

  await api.storage.local.set({
    provider,
    apiKey:           inputApiKey.value,   // stored as-is, never logged
    model,
    openaiSttKey:     inputSttKey.value,
    checkIntervalSec: interval,
    language:         "es",
    theme:            selectTheme.value,
  });

  confirmMsg.classList.add("visible");
  setTimeout(() => confirmMsg.classList.remove("visible"), 2200);
});

loadSettings();

// Keep the theme dropdown in sync when another surface (e.g. the popup toggle)
// writes a new theme value while this options page is open.  Without this,
// clicking Save after a popup-initiated change would silently revert the theme.
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.theme) {
    selectTheme.value = changes.theme.newValue ?? "auto";
  }
});
