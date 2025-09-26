// utils/lrExtractor.js
// ChatGPT (gpt-5-mini) single-call LR extractor.
// Exports: extractDetails(message) and isStructuredLR(message)
//
// Behavior changes per request:
// - Uses OpenAI (gpt-5-mini) in a single API call (no retries).
// - Does NOT apply local inference/heuristics to fabricate missing fields.
// - Expects the model to return EXACTLY one JSON object (as per prompt).
//
// USAGE: set process.env.OPENAI_API_KEY

'use strict';

const fetch = global.fetch || require('node-fetch');
const OpenAI = require('openai');

const API_KEY = process.env.GEMINI_API_KEY || '';
if (!API_KEY) {
  console.warn("[lrExtractor] WARNING: No OpenAI API key found. Set process.env.OPENAI_API_KEY.");
}
const openai = new OpenAI({ apiKey: API_KEY });

// Model to use (single-call)
const MODEL_NAME = "gpt-5-mini";

// ----------------- Small helpers (only for safe trimming) -----------------
const safeString = (v) => (v === undefined || v === null) ? "" : String(v).trim();

// Try extract JSON object from messy AI text (still required because model may add text)
function tryParseJsonFromText(text) {
  if (!text) return null;
  const txt = String(text).trim();
  // find first {...} block
  const jmatch = txt.match(/\{[\s\S]*\}/);
  if (!jmatch) return null;
  const raw = jmatch[0];
  try {
    return JSON.parse(raw);
  } catch (e) {
    try {
      const safe = raw
        .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":') // quote keys
        .replace(/(['`])([^'`]*?)\1/g, function(_,qd,inner){ return JSON.stringify(inner); }) // turn quoted values to JSON string form
        .replace(/'/g, '"') // single -> double quotes
        .replace(/,(\s*[}\]])/g, "$1"); // remove trailing commas
      return JSON.parse(safe);
    } catch (e2) {
      return null;
    }
  }
}

// ----------------- Build strict prompt -----------------
function buildStrictPrompt(message) {
  return `
You are a logistics parser. Extract the following fields EXACTLY and return ONLY a single JSON object and NOTHING ELSE. Do NOT add any commentary.

Schema (all fields must exist; when not found, set to empty string ""):
{
  "truckNumber": "",
  "from": "",
  "to": "",
  "weight": "",
  "description": "",
  "name": ""
}

Requirements:
- Return a single valid JSON object only (no markdown, no code fences, no extra text).
- Do NOT attempt to guess or infer fields beyond what is explicitly present in the message text. If a field is not present, set it to "".
- Keep original spelling/casing for fields as they appear (do not change to uppercase/lowercase).
- If truckNumber contains spaces or hyphens in the message, preserve them as-is in the returned value.
- If the message contains phrases like "new truck", "new gadi", etc., and there's no plate, leave truckNumber as "" unless that phrase is explicitly the value you want returned.

Message:
"""${String(message).replace(/```/g, "")}"""
`.trim();
}

// ----------------- Single AI call -----------------
async function singleAiCall(prompt) {
  if (!API_KEY) {
    console.warn("[lrExtractor] No API key: skipping AI call.");
    return "";
  }

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600,
      temperature: 0
    });

    // Support SDK shapes: find text in response
    const choice = resp?.choices?.[0];
    if (!choice) return "";

    // Prefer `message.content` then `text`
    const content = choice.message?.content || choice.text || "";
    return content;
  } catch (err) {
    console.error("[lrExtractor] AI call error:", err && err.message ? err.message : String(err));
    return "";
  }
}

// ----------------- Public API -----------------
async function extractDetails(message) {
  const startTs = Date.now();
  console.log("[lrExtractor] extractDetails called. Snippet:", String(message || "").slice(0,300).replace(/\n/g, ' | '));

  // Empty message -> return schema with empty strings
  if (!message) {
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }

  const prompt = buildStrictPrompt(message);

  // SINGLE call only (per request)
  const aiText = await singleAiCall(prompt);
  if (!aiText) {
    console.warn("[lrExtractor] AI returned empty response -> returning empty fields.");
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }

  // Try parse JSON from the model output
  const parsed = tryParseJsonFromText(aiText);
  if (parsed && typeof parsed === "object") {
    // Ensure all keys exist and are strings; do NOT apply extra inference/normalization.
    const out = {
      truckNumber: safeString(parsed.truckNumber),
      from: safeString(parsed.from),
      to: safeString(parsed.to),
      weight: safeString(parsed.weight),
      description: safeString(parsed.description),
      name: safeString(parsed.name)
    };
    console.log("[lrExtractor] Parsed result (took ms):", Date.now() - startTs, out);
    return out;
  }

  // Could not parse JSON -> return empty schema (no fallback)
  console.warn("[lrExtractor] Could not parse JSON from AI output -> returning empty fields.");
  return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
}

async function isStructuredLR(message) {
  try {
    const d = await extractDetails(message);
    return Boolean(d && d.truckNumber && d.to && d.weight && d.description);
  } catch (e) {
    console.error("[lrExtractor] isStructuredLR error:", e && e.message ? e.message : e);
    return false;
  }
}

module.exports = { extractDetails, isStructuredLR };
