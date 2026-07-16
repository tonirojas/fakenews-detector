/**
 * lib/providers.js
 * LLM provider adapters — protocol-based dispatch.
 * Imported as an ES module by background.js.
 *
 * Exports:
 *   factCheck(settings, text, context?) → Promise<AnalysisResult>
 *   summarizeSession(settings, claims) → Promise<string>
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

import { getProvider, defaultModelFor } from "./models.js";

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
    return "URL base no válida (solo https, o http para localhost / 127.0.0.1 / [::1])";
  }
  if (parsed.protocol === "https:") return null;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]")
  ) {
    return null;
  }
  return "URL base no válida (solo https, o http para localhost / 127.0.0.1 / [::1])";
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
// System prompt for session summary (instructions in English, output in Spanish)
// ---------------------------------------------------------------------------
const SUMMARY_SYSTEM_PROMPT = `You are an expert media reliability analyst. You will receive a list of factual claims extracted from content analyzed during this browsing session, along with their fact-check results.

Write a concise CONCLUSION IN SPANISH (3 to 6 sentences, plain prose only — no JSON, no markdown headers, no bullet points) about the overall reliability of the analyzed content. Your conclusion must:
1. State how many claims were evaluated as each verdict: verdadera (true), falsa (false), dudosa (uncertain), no verificable (unverifiable).
2. Give an overall trustworthiness judgment about the analyzed content.
3. Include a clear warning if significant misinformation (false or uncertain claims) was detected.

Do NOT invent or add claims beyond those provided. Synthesize only what you receive. Write ONLY the conclusion paragraph — no preamble, no labels, no JSON.`;

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

// ---------------------------------------------------------------------------
// Shared helper: strip <think>...</think> blocks emitted by reasoning models
// (e.g. MiniMax M2.x, DeepSeek-R1). The pattern matches from <think> to the
// first </think> OR end-of-string, covering both complete blocks and
// unterminated opening tags in one pass. Callers handle any remaining stray
// closing tags according to their parsing context (JSON vs. prose).
// ---------------------------------------------------------------------------
function stripThinkBlocks(raw) {
  return raw.replace(/<think>(?:(?!<\/think>)[\s\S])*?(?:<\/think>|$)/gi, "");
}

function parseAnalysisResult(raw, fallbackReason) {
  // Reasoning models (e.g. MiniMax M2.x, DeepSeek-R1) emit inline <think>...</think>
  // blocks before/around the JSON payload. Strip them before attempting to parse.
  let withoutThink = stripThinkBlocks(raw);
  // If a stray closing tag with no matching opening remains (e.g. response started
  // mid-think-block: '</think>{json}'), drop everything up to and including it —
  // but only when it appears before the first '{' so JSON string values that
  // contain </think> are never affected.
  const firstBrace = withoutThink.indexOf("{");
  const firstClose = withoutThink.indexOf("</think>");
  if (firstClose !== -1 && (firstBrace === -1 || firstClose < firstBrace)) {
    withoutThink = withoutThink.slice(firstClose + "</think>".length);
  }

  // Strip possible markdown fences. Trim first so leading whitespace left behind
  // by <think> removal does not defeat the fence anchors (^ / $).
  const cleaned = withoutThink.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
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
// Accepts a `system` parameter so the same adapter serves both factCheck
// (SYSTEM_PROMPT) and summarizeSession (SUMMARY_SYSTEM_PROMPT).
// ---------------------------------------------------------------------------
async function callAnthropic({ apiKey, model, text, baseUrl, system }) {
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
      system,
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
// `system`   — system prompt string (replaces the hardcoded SYSTEM_PROMPT)
// `jsonMode` — when true (default) requests response_format:json_object and
//              retries without it on providers that reject that field.
//              When false (summarizeSession) skips JSON mode entirely so the
//              model returns natural-language prose.
// ---------------------------------------------------------------------------
async function callOpenAI({ apiKey, model, text, baseUrl, requiresKey, system, jsonMode = true }) {
  const url = `${baseUrl}/chat/completions`;
  const headers = { "content-type": "application/json" };
  // Ollama and other local servers may not require a key
  if (requiresKey !== false) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  if (jsonMode) {
    // First attempt: include response_format for clean JSON output
    const bodyWith = JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
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
            { role: "system", content: system },
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

  // Plain text mode (no JSON response format) — used by summarizeSession
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    }),
  });

  if (!response.ok) {
    const excerpt = (await response.text()).slice(0, 200);
    throw new Error(`OpenAI-compat ${response.status}: ${excerpt}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Protocol adapter — Gemini
// `system`   — system prompt string
// `jsonMode` — when true adds generationConfig.responseMimeType:"application/json"
// ---------------------------------------------------------------------------
async function callGemini({ apiKey, model, text, baseUrl, system, jsonMode = true }) {
  const url = `${baseUrl}/models/${model}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text }] }],
  };
  if (jsonMode) {
    body.generationConfig = { responseMimeType: "application/json" };
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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
        system: SYSTEM_PROMPT,
      });
      break;

    case "openai":
      raw = await callOpenAI({
        apiKey: settings.apiKey,
        model: settings.model,
        text: fullText,
        baseUrl: base,
        requiresKey: provider.requiresKey,
        system: SYSTEM_PROMPT,
        jsonMode: true,
      });
      break;

    case "gemini":
      raw = await callGemini({
        apiKey: settings.apiKey,
        model: settings.model,
        text: fullText,
        baseUrl: base,
        system: SYSTEM_PROMPT,
        jsonMode: true,
      });
      break;

    default:
      throw new Error(`Unknown protocol: ${provider.protocol}`);
  }

  return parseAnalysisResult(raw, raw);
}

// ---------------------------------------------------------------------------
// Spanish verdict labels used to build the summarizeSession user message
// ---------------------------------------------------------------------------
const VERDICT_LABELS_ES = {
  true:         "verdadera",
  false:        "falsa",
  uncertain:    "dudosa",
  unverifiable: "no verificable",
};

// Token-budget caps: never send more than 40 claims or 6000 chars of input
const SUMMARY_MAX_CLAIMS = 40;
const SUMMARY_MAX_CHARS  = 6000;

// ---------------------------------------------------------------------------
// Public: summarizeSession
// ---------------------------------------------------------------------------
/**
 * Asks the configured LLM for a concise Spanish-language conclusion about the
 * overall reliability of the claims analyzed in this session.
 *
 * Uses the same protocol adapters as factCheck (same base-URL / key / header
 * handling) but passes SUMMARY_SYSTEM_PROMPT and skips JSON mode so the model
 * produces natural-language prose instead of structured JSON.
 *
 * @param {object} settings  Same shape as factCheck: {provider, apiKey, model, baseUrl, …}
 * @param {Array}  claims    Flat array of claim objects ({text, verdict, confidence, reasoning})
 * @returns {Promise<string>} Plain-text conclusion in Spanish (think blocks stripped, trimmed)
 */
export async function summarizeSession(settings, claims) {
  const provider = getProvider(settings.provider);
  const model    = settings.model || defaultModelFor(settings.provider);
  const base     = effectiveBase(settings);

  // Build a compact claim list, capped to bound token usage
  let userText = "";
  let included = 0;
  let truncated = false;

  for (const c of claims) {
    const verdictEs = VERDICT_LABELS_ES[c.verdict] ?? c.verdict;
    const entry = [
      `[${included + 1}] Afirmación: "${c.text}"`,
      `    Veredicto: ${verdictEs} | Confianza: ${c.confidence ?? 0}%`,
      c.reasoning?.trim() ? `    Razonamiento: "${c.reasoning.trim()}"` : null,
    ].filter(Boolean).join("\n") + "\n\n";

    if (included >= SUMMARY_MAX_CLAIMS || userText.length + entry.length > SUMMARY_MAX_CHARS) {
      truncated = true;
      break;
    }
    userText += entry;
    included++;
  }

  if (truncated) {
    userText += `[Nota: se muestran ${included} de ${claims.length} afirmaciones en total.]\n`;
  }

  let raw;
  switch (provider.protocol) {
    case "anthropic":
      raw = await callAnthropic({
        apiKey: settings.apiKey,
        model,
        text: userText,
        baseUrl: base,
        system: SUMMARY_SYSTEM_PROMPT,
      });
      break;

    case "openai":
      raw = await callOpenAI({
        apiKey: settings.apiKey,
        model,
        text: userText,
        baseUrl: base,
        requiresKey: provider.requiresKey,
        system: SUMMARY_SYSTEM_PROMPT,
        jsonMode: false,
      });
      break;

    case "gemini":
      raw = await callGemini({
        apiKey: settings.apiKey,
        model,
        text: userText,
        baseUrl: base,
        system: SUMMARY_SYSTEM_PROMPT,
        jsonMode: false,
      });
      break;

    default:
      throw new Error(`Unknown protocol: ${provider.protocol}`);
  }

  // Strip think blocks; for prose also remove any stray closing tags.
  return stripThinkBlocks(raw).replace(/<\/think>/gi, "").trim();
}

// ---------------------------------------------------------------------------
// Public: transcribe
// ---------------------------------------------------------------------------
/**
 * Transcribes base64-encoded audio using either an OpenAI-compatible Whisper
 * endpoint or Gemini's inline-audio capability.
 *
 * Decision logic:
 *  1. If sttKey is set → use OpenAI-compatible STT at sttBaseUrl (default OpenAI)
 *  2. If provider is openai AND has an apiKey → use the main apiKey against sttBaseUrl
 *  3. If sttBaseUrl points to a self-hosted (non-api.openai.com) endpoint → use it
 *     keyless (no Authorization header sent); the URL must still pass validateBaseUrl
 *     (https everywhere; http only for localhost / 127.0.0.1)
 *  4. If provider is gemini and none of the above matched → use Gemini inline audio
 *  5. Otherwise → throw NoSttError
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

  const rawSttBase = (settings.sttBaseUrl ?? "").trim().replace(/\/+$/, "");
  const sttBase = rawSttBase || "https://api.openai.com/v1";
  const sttModel = (settings.sttModel ?? "").trim() || "whisper-1";

  const hasExplicitSttKey = !!sttKey;
  // Only the canonical OpenAI provider covers Whisper with its own key;
  // other openai-protocol providers (DeepSeek, Groq, etc.) do not accept
  // OpenAI-keyed Whisper calls — they should fall through to the NoSttError path.
  const providerOwnsWhisper = provider.id === "openai" && !!apiKey;

  // hasNonOpenAISttBase — sttBaseUrl is set and its hostname is NOT api.openai.com.
  //   A user-configured custom STT base (self-hosted Whisper on a local Docker OR a
  //   remote VPS) enables the Whisper path even without a key. It also guards key
  //   selection below so the OpenAI provider's main apiKey is never routed to a
  //   third-party host. validateBaseUrl (called before any fetch) forces remote
  //   endpoints to be https, so captured audio is never sent in cleartext.
  let hasNonOpenAISttBase = false;
  if (rawSttBase) {
    try {
      const parsed = new URL(rawSttBase);
      hasNonOpenAISttBase = parsed.hostname.toLowerCase() !== "api.openai.com";
    } catch {
      // Unparseable URL — leave the flag false; validateBaseUrl will reject it below.
    }
  }

  const useWhisper = hasExplicitSttKey || providerOwnsWhisper || hasNonOpenAISttBase;
  // Key selection:
  //   1. Explicit sttKey → always use it (any endpoint)
  //   2. providerOwnsWhisper AND sttBaseUrl is the canonical openai.com endpoint → use apiKey
  //      (!hasNonOpenAISttBase guards against sending the OpenAI key to a third-party host)
  //   3. Otherwise → empty string (keyless self-hosted server, local or remote https)
  const whisperKey = hasExplicitSttKey
    ? sttKey
    : !hasNonOpenAISttBase && providerOwnsWhisper
    ? apiKey
    : "";

  if (useWhisper) {
    // Defense in depth: validate the effective STT base URL before any network call.
    // validateBaseUrl enforces https-only except http for localhost/127.0.0.1/[::1],
    // keeping audio from a remote VPS out of cleartext.
    const urlErr = validateBaseUrl(sttBase);
    if (urlErr) throw new Error(urlErr);

    const byteChars = atob(base64Audio);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });

    const form = new FormData();
    form.append("file", blob, "audio.webm");
    form.append("model", sttModel);
    form.append("language", language);

    // Omit the Authorization header entirely for keyless self-hosted servers;
    // include it only when a key is actually present.
    const whisperHeaders = {};
    if (whisperKey) {
      whisperHeaders["Authorization"] = `Bearer ${whisperKey}`;
    }

    const response = await fetch(`${sttBase}/audio/transcriptions`, {
      method: "POST",
      headers: whisperHeaders,
      body: form,
    });

    if (!response.ok) {
      const excerpt = (await response.text()).slice(0, 200);
      throw new Error(`Whisper ${response.status}: ${excerpt}`);
    }

    const data = await response.json();
    return data.text ?? "";
  }

  // Gemini inline-audio path (when no STT key, no provider Whisper, and no custom STT base)
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
