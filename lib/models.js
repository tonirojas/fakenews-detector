/**
 * lib/models.js
 * Provider registry and model catalog for all supported LLM providers.
 * Imported by ES-module contexts only (background.js, options/options.js).
 * Do NOT import in content scripts — they are classic scripts.
 */

/**
 * @typedef {{ id: string, label: string, tier: string, recommended?: boolean }} ModelEntry
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   protocol: "openai"|"anthropic"|"gemini",
 *   baseUrl: string|null,
 *   keyUrl?: string,
 *   models: ModelEntry[],
 *   requiresKey?: boolean,
 *   isCustom?: boolean
 * }} ProviderEntry
 */

/** @type {ProviderEntry[]} */
export const PROVIDERS = [
  // ── Principales ──────────────────────────────────────────────────────────
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", tier: "fast",     recommended: true },
      { id: "claude-sonnet-5",           label: "Claude Sonnet 5",  tier: "balanced"                   },
      { id: "claude-opus-4-8",           label: "Claude Opus 4.8",  tier: "quality"                    },
    ],
  },
  {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini", tier: "fast",     recommended: true },
      { id: "gpt-4o",      label: "GPT-4o",      tier: "balanced"                    },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", tier: "fast",     recommended: true },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "balanced"                    },
      { id: "gemini-2.5-pro",   label: "Gemini 2.5 Pro",   tier: "quality"                     },
    ],
  },

  // ── China ─────────────────────────────────────────────────────────────────
  // Mainland China endpoints differ (e.g. api.moonshot.cn, open.bigmodel.cn,
  // dashscope.aliyuncs.com) — use the editable base URL field to override.
  {
    id: "deepseek",
    label: "DeepSeek (China)",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat",     label: "DeepSeek Chat",     tier: "fast",    recommended: true },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner", tier: "quality"                    },
    ],
  },
  {
    id: "qwen",
    label: "Qwen / Alibaba (China)",
    protocol: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyUrl: "https://bailian.console.alibabacloud.com/",
    models: [
      { id: "qwen-turbo", label: "Qwen Turbo", tier: "fast",     recommended: true },
      { id: "qwen-plus",  label: "Qwen Plus",  tier: "balanced"                    },
      { id: "qwen-max",   label: "Qwen Max",   tier: "quality"                     },
    ],
  },
  {
    id: "kimi",
    label: "Kimi / Moonshot (China)",
    protocol: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    models: [
      { id: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo",    tier: "fast",     recommended: true },
      { id: "kimi-k2-0905-preview",  label: "Kimi K2 Balanced", tier: "balanced"                    },
    ],
  },
  {
    id: "glm",
    label: "GLM / Zhipu (China)",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    models: [
      { id: "glm-4.5-air", label: "GLM-4.5 Air", tier: "fast",    recommended: true },
      { id: "glm-4.6",     label: "GLM-4.6",     tier: "quality"                    },
    ],
  },

  // ── Otros / Local ─────────────────────────────────────────────────────────
  {
    id: "grok",
    label: "Grok / xAI",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai/",
    models: [
      { id: "grok-4-fast", label: "Grok 4 Fast", tier: "fast",    recommended: true },
      { id: "grok-4",      label: "Grok 4",      tier: "quality"                    },
    ],
  },
  {
    id: "mistral",
    label: "Mistral AI",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys/",
    models: [
      { id: "mistral-small-latest", label: "Mistral Small", tier: "fast",    recommended: true },
      { id: "mistral-large-latest", label: "Mistral Large", tier: "quality"                    },
    ],
  },
  {
    id: "groq",
    label: "Groq (Llama)",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", tier: "fast", recommended: true },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter (multi-modelo)",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/settings/keys",
    models: [], // free-text; placeholder: "deepseek/deepseek-chat"
  },
  {
    id: "ollama",
    label: "Ollama (local, sin clave)",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    models: [], // free-text; placeholder: "llama3.2"
    requiresKey: false,
  },
  {
    id: "custom",
    label: "Personalizado (compatible OpenAI)",
    protocol: "openai",
    baseUrl: null, // user must fill in the base URL field
    models: [],    // free-text
    isCustom: true,
  },
];

/** Quick lookup map built once at module load. */
const _providerMap = new Map(PROVIDERS.map((p) => [p.id, p]));

/**
 * Returns the provider entry for the given id.
 * Falls back to a custom-shaped default when the id is not in the registry.
 *
 * @param {string} id
 * @returns {ProviderEntry}
 */
export function getProvider(id) {
  return _providerMap.get(id) ?? {
    id,
    label: id,
    protocol: "openai",
    baseUrl: null,
    models: [],
    isCustom: true,
  };
}

/**
 * Backward-compatible model catalog derived from PROVIDERS.
 * Keyed by provider id; value is the models array.
 * @type {Record<string, ModelEntry[]>}
 */
export const MODEL_CATALOG = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p.models])
);

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
 * Returns the id of the recommended model for the given provider.
 * Returns "" when the catalog is empty (openrouter, ollama, custom).
 *
 * @param {string} providerId
 * @returns {string} model id, or "" if the catalog is empty
 */
export function defaultModelFor(providerId) {
  const catalog = getProvider(providerId).models ?? [];
  const rec = catalog.find((m) => m.recommended);
  return rec?.id ?? catalog[0]?.id ?? "";
}
