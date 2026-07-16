/**
 * lib/providers.js
 * LLM provider adapters — protocol-based dispatch.
 * Imported as an ES module by background.js.
 *
 * Exports:
 *   factCheck(settings, text, context?) → Promise<AnalysisResult>
 *   transcribe({settings, base64Audio, mimeType}) → Promise<string>
 *   validateBaseUrl(url) → null | string  (null = valid; string = Spanish error)
 *   NoSttError
 *
 * AnalysisResult shape:
 *   { claims: [{text, verdict, confidence, reasoning, sources}], overall: {verdict, confidence} }
 *
 * Verdict enum: "true" | "uncertain" | "false" | "unverifiable"
 *
 * Protocol dispatch:
 *   "openai"    — POST {base}/chat/completions, Bearer key (de-facto OpenAI-compatible)
 *   "anthropic" — POST {base}/v1/messages, x-api-key
 *   "gemini"    — POST {base}/models/{model}:generateContent, x-goog-api-key
 */

import { getProvider } from "./models.js";

// ---------------------------------------------------------------------------
// Typed error so callers can surface a specific Spanish message
// ---------------------------------------------------------------------------
export class NoSttError extends Error {
  constructor() {
    super("NO_STT");
    this.code = "NO_STT";
  }
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------
/**
 * Validates a user-supplied base URL.
 * Rules: must parse as URL, protocol must be https:, except http: is allowed
 * for localhost / 127.0.0.1 only (Ollama local server).
 *
 * @param {string} url
 * @returns {null|string} null if valid, Spanish error message if invalid
 */
export function validateBaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "URL base no válida (solo https, o http para localhost)";
  }
  if (parsed.protocol === "https:") return null;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    return null;
  }
  return "URL base no válida (solo https, o http para localhost)";
}

// ---------------------------------------------------------------------------
// Resolve effective base URL from settings + provider preset
// ---------------------------------------------------------------------------
function effectiveBase(settings) {
  const provider = getProvider(settings.provider);
  // User override wins; strip trailing slashes
  const override = typeof settings.baseUrl === "string"
    ? settings.baseUrl.trim().replace(/\/+$/, "")
    : "";
  return override || provider.baseUrl || "";
}

// ---------------------------------------------------------------------------
// System prompt for fact-checking
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a rigorous fact-checker. Given the text provided by the user, do the following:

1. Extract every discrete factual claim (ignore opinions, feelings, and rhetorical questions).
2. For each claim evaluate it and assign:
   - verdict: one of "true", "uncertain", "false", or "unverifiable"
   - confidence: integer 0-100
   - reasoning: a short explanation IN SPANISH (2-3 sentences max)
   - sources: array of {title, url} — include ONLY if you are highly confident the source is real and accessible; otherwise use an empty array
3. If a claim concerns events that are likely AFTER your knowledge cutoff date, set verdict to "unverifiable" and state in the reasoning (in Spanish): "No puedo verificarlo con mi conocimiento estático porque es probable que ocurriera después de mi fecha de corte."
4. After evaluating all claims, compute an overall verdict (worst-case: false > uncertain > unverifiable > true) and overall confidence (average of claim confidences).
5. Respond ONLY with valid JSON — no markdown fences, no prose outside JSON — in this exact shape:
{
  "claims": [
    {"text": "...", "verdict": "...", "confidence": 0, "reasoning": "...", "sources": [{"title": "...", "url": "..."}]}
  ],
  "overall": {"verdict": "...", "confidence": 0}
}`;

// ---------------------------------------------------------------------------
// Verdict validation helpers
// ---------------------------------------------------------------------------
const VALID_VERDICTS = new Set(["true", "uncertain", "false", "unverifiable"]);

function safeVerdict(v) {
  return VALID_VERDICTS.has(v) ? v : "unverifiable";
}

function clampConfidence(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 50;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function parseAnalysisResult(raw, fallbackReason) {
  // Strip possible markdown fences
  const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      claims: [
        {
          text: "Error al parsear la respuesta del modelo.",
          verdict: "unverifiable",
          confidence: 0,
          reasoning: fallbackReason
            ? `Respuesta no válida: ${fallbackReason.slice(0, 200)}`
            : "La respuesta del modelo no era JSON válido.",
          sources: [],
        },
      ],
      overall: { verdict: "unverifiable", confidence: 0 },
    };
  }

  const claims = Array.isArray(parsed.claims)
    ? parsed.claims.map((c) => ({
        text: String(c.text ?? ""),
        verdict: safeVerdict(c.verdict),
        confidence: clampConfidence(c.confidence),
        reasoning: String(c.reasoning ?? ""),
        sources: Array.isArray(c.sources)
          ? c.sources.filter((s) => s && s.title && s.url)
          : [],
      }))
    : [];

  const overall = parsed.overall ?? {};
  return {
    claims,
    overall: {
      verdict: safeVerdict(overall.verdict),
      confidence: clampConfidence(overall.confidence),
    },
  };
}

// ---------------------------------------------------------------------------
// Protocol adapter — Anthropic
// ---------------------------------------------------------------------------
async function callAnthropic({ apiKey, model, text, baseUrl }) {
  const url = `${baseUrl}/v1/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!response.ok) {
    const excerpt = (await response.text()).slice(0, 200);
    throw new Error(`Anthropic ${response.status}: ${excerpt}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// Protocol adapter — OpenAI-compatible (the de-facto standard)
// ---------------------------------------------------------------------------
async function callOpenAI({ apiKey, model, text, baseUrl, requiresKey }) {
  const url = `${baseUrl}/chat/completions`;
  const headers = { "content-type": "application/json" };
  // Ollama and other local servers may not require a key
  if (requiresKey !== false) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // First attempt: include response_format for clean JSON output
  const bodyWith = JSON.stringify({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
  });

  let response = await fetch(url, { method: "POST", headers, body: bodyWith });

  // Many OpenAI-compatible providers reject response_format — retry once without it
  if (!response.ok && response.status >= 400 && response.status < 500) {
    const errText = (await response.text()).slice(0, 400);
    if (/response_format|json/i.test(errText)) {
      const bodyWithout = JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      });
      response = await fetch(url, { method: "POST", headers, body: bodyWithout });
      if (!response.ok) {
        const excerpt = (await response.text()).slice(0, 200);
        throw new Error(`OpenAI-compat ${response.status}: ${excerpt}`);
      }
    } else {
      throw new Error(`OpenAI-compat ${response.status}: ${errText.slice(0, 200)}`);
    }
  } else if (!response.ok) {
    const excerpt = (await response.text()).slice(0, 200);
    throw new Error(`OpenAI-compat ${response.status}: ${excerpt}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Protocol adapter — Gemini
// ---------------------------------------------------------------------------
async function callGemini({ apiKey, model, text, baseUrl }) {
  const url = `${baseUrl}/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    const excerpt = (await response.text()).slice(0, 200);
    throw new Error(`Gemini ${response.status}: ${excerpt}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// Public: factCheck
// ---------------------------------------------------------------------------
/**
 * Fact-checks the given text using the provider configured in settings.
 *
 * @param {object} settings  Full settings object: {provider, apiKey, model, baseUrl, …}
 * @param {string} text      Text to fact-check
 * @param {string} [context] Optional prior transcript context
 * @returns {Promise<AnalysisResult>}
 */
export async function factCheck(settings, text, context) {
  const provider = getProvider(settings.provider);
  const base = effectiveBase(settings);
  const fullText = context
    ? `[Contexto previo]:\n${context}\n\n[Texto a analizar]:\n${text}`
    : text;

  let raw;
  switch (provider.protocol) {
    case "anthropic":
      raw = await callAnthropic({
        apiKey: settings.apiKey,
        model: settings.model,
        text: fullText,
        baseUrl: base,
      });
      break;

    case "openai":
      raw = await callOpenAI({
        apiKey: settings.apiKey,
        model: settings.model,
        text: fullText,
        baseUrl: base,
        requiresKey: provider.requiresKey,
      });
      break;

    case "gemini":
      raw = await callGemini({
        apiKey: settings.apiKey,
        model: settings.model,
        text: fullText,
        baseUrl: base,
      });
      break;

    default:
      throw new Error(`Unknown protocol: ${provider.protocol}`);
  }

  return parseAnalysisResult(raw, raw);
}

// ---------------------------------------------------------------------------
// Public: transcribe
// ---------------------------------------------------------------------------
/**
 * Transcribes base64-encoded audio using either an OpenAI-compatible Whisper
 * endpoint or Gemini's inline-audio capability.
 *
 * Decision logic:
 *  1. If sttKey is set → use OpenAI-compatible STT at sttBaseUrl (default openai)
 *  2. If provider is openai-protocol AND has an apiKey AND requiresKey !== false
 *     → use the main apiKey against sttBaseUrl
 *  3. If provider is gemini → use Gemini inline audio
 *  4. Otherwise → throw NoSttError
 *
 * Legacy migration: the settings object may contain openaiSttKey (old name);
 * background.js maps it to sttKey before passing settings here.
 *
 * @param {object} params
 * @param {object} params.settings   Full settings object from storage
 * @param {string} params.base64Audio
 * @param {string} params.mimeType
 * @returns {Promise<string>} Transcript text
 */
export async function transcribe({ settings, base64Audio, mimeType }) {
  const provider = getProvider(settings.provider);
  const { apiKey, sttKey, language = "es" } = settings;

  const sttBase = (settings.sttBaseUrl ?? "").trim().replace(/\/+$/, "")
    || "https://api.openai.com/v1";
  const sttModel = (settings.sttModel ?? "").trim() || "whisper-1";

  const hasExplicitSttKey = !!sttKey;
  // Only the canonical OpenAI provider covers Whisper with its own key;
  // other openai-protocol providers (DeepSeek, Groq, etc.) do not accept
  // OpenAI-keyed Whisper calls — they should fall through to NoSttError.
  const providerOwnsWhisper = provider.id === "openai" && !!apiKey;

  const useWhisper = hasExplicitSttKey || providerOwnsWhisper;
  const whisperKey = hasExplicitSttKey ? sttKey : apiKey;

  if (useWhisper) {
    const byteChars = atob(base64Audio);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });

    const form = new FormData();
    form.append("file", blob, "audio.webm");
    form.append("model", sttModel);
    form.append("language", language);

    const response = await fetch(`${sttBase}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${whisperKey}` },
      body: form,
    });

    if (!response.ok) {
      const excerpt = (await response.text()).slice(0, 200);
      throw new Error(`Whisper ${response.status}: ${excerpt}`);
    }

    const data = await response.json();
    return data.text ?? "";
  }

  // Gemini inline-audio path (when no STT key is configured)
  if (provider.protocol === "gemini") {
    const base = effectiveBase(settings);
    const url = `${base}/models/${settings.model}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data: base64Audio } },
              { text: "Transcribe this audio verbatim. Return only the transcript text." },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const excerpt = (await response.text()).slice(0, 200);
      throw new Error(`Gemini STT ${response.status}: ${excerpt}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  // No STT method available for this provider/configuration
  throw new NoSttError();
}
