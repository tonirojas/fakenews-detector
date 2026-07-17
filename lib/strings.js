/**
 * lib/strings.js
 * Central repository of user-visible Spanish strings.
 * Imported by ES-module contexts (background, popup, options, sidepanel).
 * Content scripts are NOT modules — they inline their own copy of VERDICT_UI.
 */

// Verdict → display metadata
export const VERDICT_UI = {
  true: {
    label: "Lo que dice es verdad",
    color: "green",
    hex: "#16a34a",
  },
  uncertain: {
    label: "Peligro, podría estar mintiendo",
    color: "amber",
    hex: "#f59e0b",
  },
  false: {
    label: "Peligro, FAKE NEW confirmada",
    color: "red",
    hex: "#dc2626",
  },
  unverifiable: {
    label: "Sin datos suficientes para verificar",
    color: "gray",
    hex: "#6b7280",
  },
};

// Provider display names — kept for backward compat; prefer getProvider(id).label from models.js
export const PROVIDER_NAMES = {
  anthropic:   "Anthropic (Claude)",
  openai:      "OpenAI (ChatGPT)",
  gemini:      "Google Gemini",
  deepseek:    "DeepSeek",
  qwen:        "Qwen / Alibaba",
  kimi:        "Kimi / Moonshot",
  glm:         "GLM / Zhipu",
  grok:        "Grok / xAI",
  mistral:     "Mistral AI",
  groq:        "Groq (Llama)",
  openrouter:  "OpenRouter",
  ollama:      "Ollama (local)",
  custom:      "Personalizado",
};

// Build overall banner text
export function buildBannerText(overallVerdict) {
  const ui = VERDICT_UI[overallVerdict] ?? VERDICT_UI.unverifiable;
  if (overallVerdict === "false" || overallVerdict === "uncertain") {
    return `Peligro, posible FAKE NEW — ${ui.label}`;
  }
  return ui.label;
}

// Donation chip — single source of truth
// Replace TU_USUARIO with your real Buy Me a Coffee handle before publishing.
export const DONATION_URL   = "https://www.buymeacoffee.com/TU_USUARIO";
export const DONATION_LABEL = "☕ Invítame a un café";

// Generic Spanish error strings
export const ERRORS = {
  NO_API_KEY: "No hay clave de API configurada. Ve a Configuración para añadirla.",
  NO_STT:
    "La transcripción de audio requiere configurar un endpoint STT compatible con Whisper (Groq, servidor autoalojado — la clave es opcional en servidores propios) o usar Gemini como proveedor.",
  ANALYSIS_FAILED: "El análisis falló. Comprueba tu clave de API e inténtalo de nuevo.",
  TAB_NOT_FOUND: "No se pudo acceder a la pestaña activa.",
  CONTEXT_INVALIDATED: "El contexto de la extensión se ha invalidado. Recarga la página.",
  AUDIO_CAPTURE_UNSUPPORTED: "La captura de audio solo está disponible en Chrome y Edge.",
  MIC_PERMISSION_DENIED:
    "No se pudo acceder al micrófono. Concede el permiso en Configuración → Micrófono y vuelve a intentarlo.",
};
