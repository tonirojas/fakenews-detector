/**
 * lib/models.js
 * Canonical model catalog for all supported LLM providers.
 * Imported by ES-module contexts only (background.js, options/options.js).
 * Do NOT import in content scripts — they are classic scripts.
 */

/**
 * @typedef {{ id: string, label: string, tier: string, recommended?: boolean }} ModelEntry
 */

/** @type {Record<string, ModelEntry[]>} */
export const MODEL_CATALOG = {
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", tier: "fast",     recommended: true },
    { id: "claude-sonnet-5",           label: "Claude Sonnet 5",  tier: "balanced"                   },
    { id: "claude-opus-4-8",           label: "Claude Opus 4.8",  tier: "quality"                    },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o mini", tier: "fast",     recommended: true },
    { id: "gpt-4o",      label: "GPT-4o",      tier: "balanced"                    },
  ],
  gemini: [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", tier: "fast",    recommended: true },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "balanced"                   },
    { id: "gemini-2.5-pro",   label: "Gemini 2.5 Pro",   tier: "quality"                    },
  ],
};

/**
 * Spanish tier hint labels shown next to model names in the options select.
 * @type {Record<string, string>}
 */
export const TIER_LABELS = {
  fast:     "⚡ Rápido — recomendado para tiempo real",
  balanced: "Equilibrado",
  quality:  "Máxima calidad (más lento y caro)",
};

/**
 * Returns the id of the recommended (fast) model for the given provider.
 * Falls back to the first model if none is explicitly marked recommended.
 *
 * @param {string} provider - "anthropic" | "openai" | "gemini"
 * @returns {string} model id
 */
export function defaultModelFor(provider) {
  const catalog = MODEL_CATALOG[provider] ?? [];
  const rec = catalog.find((m) => m.recommended);
  return rec?.id ?? catalog[0]?.id ?? "";
}
