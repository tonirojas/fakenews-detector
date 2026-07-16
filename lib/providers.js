/**
 * lib/providers.js
 * LLM provider adapters. Imported as an ES module by background.js.
 *
 * Exports:
 *   factCheck({provider, apiKey, model, text, context}) → Promise<AnalysisResult>
 *   transcribe({settings, base64Audio, mimeType})       → Promise<string>
 *
 * AnalysisResult shape:
 *   { claims: [{text, verdict, confidence, reasoning, sources}], overall: {verdict, confidence} }
 *
 * Verdict enum: "true" | "uncertain" | "false" | "unverifiable"
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const OPENAI_API    = "https://api.openai.com/v1/chat/completions";
const OPENAI_STT    = "https://api.openai.com/v1/audio/transcriptions";

// Typed error so callers can surface a specific Spanish message
export class NoSttError extends Error {
  constructor() {
    super("NO_STT");
    this.code = "NO_STT";
  }
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

  // Normalise claims
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
// Provider-specific fetch helpers
// ---------------------------------------------------------------------------
async function callAnthropic({ apiKey, model, text }) {
  const response = await fetch(ANTHROPIC_API, {
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

async function callOpenAI({ apiKey, model, text }) {
  const response = await fetch(OPENAI_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  if (!response.ok) {
    const excerpt = (await response.text()).slice(0, 200);
    throw new Error(`OpenAI ${response.status}: ${excerpt}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callGemini({ apiKey, model, text }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
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
 * @param {object} params
 * @param {"anthropic"|"openai"|"gemini"} params.provider
 * @param {string} params.apiKey
 * @param {string} params.model
 * @param {string} params.text       - text to fact-check
 * @param {string} [params.context]  - optional prior transcript context
 * @returns {Promise<AnalysisResult>}
 */
export async function factCheck({ provider, apiKey, model, text, context }) {
  const fullText = context ? `[Contexto previo]:\n${context}\n\n[Texto a analizar]:\n${text}` : text;

  let raw;
  switch (provider) {
    case "anthropic":
      raw = await callAnthropic({ apiKey, model, text: fullText });
      break;
    case "openai":
      raw = await callOpenAI({ apiKey, model, text: fullText });
      break;
    case "gemini":
      raw = await callGemini({ apiKey, model, text: fullText });
      break;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }

  return parseAnalysisResult(raw, raw);
}

// ---------------------------------------------------------------------------
// Public: transcribe
// ---------------------------------------------------------------------------
/**
 * @param {object} params
 * @param {object} params.settings   - full settings object from storage
 * @param {string} params.base64Audio
 * @param {string} params.mimeType
 * @returns {Promise<string>} transcript text
 */
export async function transcribe({ settings, base64Audio, mimeType }) {
  const { provider, apiKey, openaiSttKey, language = "es" } = settings;

  // Decide which STT path to use
  const useWhisper = provider === "openai" || !!openaiSttKey;
  const whisperKey = provider === "openai" ? apiKey : openaiSttKey;

  if (useWhisper) {
    // Convert base64 to Blob
    const byteChars = atob(base64Audio);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });

    const form = new FormData();
    form.append("file", blob, "audio.webm");
    form.append("model", "whisper-1");
    form.append("language", language);

    const response = await fetch(OPENAI_STT, {
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

  if (provider === "gemini") {
    const { model } = settings;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
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

  // Anthropic without STT key → typed error
  throw new NoSttError();
}
