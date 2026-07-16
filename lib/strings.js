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

// Provider display names
export const PROVIDER_NAMES = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google Gemini",
};

// Provider default models
export const PROVIDER_DEFAULTS = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
};

// Build overall banner text
export function buildBannerText(overallVerdict) {
  const ui = VERDICT_UI[overallVerdict] ?? VERDICT_UI.unverifiable;
  if (overallVerdict === "false" || overallVerdict === "uncertain") {
    return `Peligro, posible FAKE NEW — ${ui.label}`;
  }
  return ui.label;
}

// Generic Spanish error strings
export const ERRORS = {
  NO_API_KEY: "No hay clave de API configurada. Ve a Configuración para añadirla.",
  NO_STT:
    "La transcripción de audio requiere una clave de OpenAI (Whisper) o usar Gemini como proveedor.",
  ANALYSIS_FAILED: "El análisis falló. Comprueba tu clave de API e inténtalo de nuevo.",
  TAB_NOT_FOUND: "No se pudo acceder a la pestaña activa.",
  CONTEXT_INVALIDATED: "El contexto de la extensión se ha invalidado. Recarga la página.",
};
