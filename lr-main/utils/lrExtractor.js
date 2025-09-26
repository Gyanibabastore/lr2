// utils/lrExtractor.js
// LR extractor using ONLY the model (retries up to 3 times).
// Exports: extractDetails(message) and isStructuredLR(message)
//
// Behavior:
// - Tries to get a strict JSON from model up to 3 attempts.
// - Uses deterministic sampling (temperature: 0) when model supports it.
// - If model never returns valid JSON, returns empty fields (no local fallback).

'use strict';
try { require('dotenv').config(); } catch (e) { /* ignore */ }

const OpenAI = require('openai');

// ---------- Config ----------
const RAW_KEY = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '';
const API_KEY = (RAW_KEY || '').toString().trim().replace(/^["'=]+|["']+$/g, '');
if (!API_KEY) console.warn("[lrExtractor] WARNING: No API key found. Set process.env.GEMINI_API_KEY or OPENAI_API_KEY.");

let openai = null;
if (API_KEY) {
  try { openai = new OpenAI({ apiKey: API_KEY }); }
  catch (e) { console.warn("[lrExtractor] Failed to create OpenAI client:", e && e.message ? e.message : e); }
}

// Default model: use gpt-4o (supports temperature). Override with LR_MODEL env var.
const MODEL_NAME = process.env.LR_MODEL || "gpt-4o";

// Heuristic: models with gpt-5 / o3 / reasoning often disallow sampling params
const supportsSampling = !(/gpt-5|o3|reasoning|reasoner/i.test(MODEL_NAME));

// Safe helpers
const safeString = v => (v === undefined || v === null) ? "" : String(v).trim();
const maskKey = k => { if(!k) return '<missing>'; const s=String(k); return s.length<=12? s : s.slice(0,6)+'...'+s.slice(-4); };
if (API_KEY) console.log("[lrExtractor] API key preview:", maskKey(API_KEY), " Model:", MODEL_NAME);

// ---------------- prompt builder (user's exact requirements embedded) ----------------
function buildStrictPrompt(message) {
  const safeMessage = String(message || "").replace(/"/g, '\\"').replace(/\r/g, '\n');
  // Base prompt (user-specified). We will also add "Attempt #n" NOTE outside when retrying.
  return `
You are a smart logistics parser.

Extract the following mandatory details from this message:

- truckNumber (which may be 9 or 10 characters long, possibly containing spaces or hyphens) 
  Example: "MH 09 HH 4512" should be returned as "MH09HH4512"
- to
- weight
- description

Also, extract the optional fields:
- from (this is optional but often present)
- name (if the message contains a pattern like "n - name", "n-name", " n name", " n. name", or any variation where 'n' is followed by '-' or '.' or space, and then the person's name — extract the text after it as the name value)

If truckNumber is missing, but the message contains words like "brllgada","bellgade","bellgad","bellgadi","new truck", "new tractor", or "new gadi", 
then set truckNumber to that phrase (exactly as it appears).

If the weight contains the word "fix" or similar, preserve it as-is.

Here is the message:
"${safeMessage}"

Return the extracted information strictly in the following JSON format (ONLY the JSON, nothing else):

{
  "truckNumber": "",
  "from": "",
  "to": "",
  "weight": "",
  "description": "",
  "name": ""
}

If any field is missing, return it as an empty string.

Important: Do not include any commentary, explanation, markdown, or text outside the JSON object. Only return the raw JSON object.
`.trim();
}

// ---------------- parse model output into JSON (robust) ----------------
function tryParseJsonFromText(text) {
  if (!text) return null;
  const txt = String(text).trim();
  try {
    const j = JSON.parse(txt);
    if (j && typeof j === 'object') return j;
  } catch (e) {
    // try to extract first {...} block
    const first = txt.indexOf('{'), last = txt.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const sub = txt.slice(first, last + 1);
      try { const j2 = JSON.parse(sub); if (j2 && typeof j2 === 'object') return j2; } catch (e2) {}
    }
  }
  return null;
}

// ---------------- normalize truck number as per user's example ----------------
function normalizeTruckNumber(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  const specialPattern = /\b(brllgada|bellgade|bellgad|bellgadi|new truck|new tractor|new gadi)\b/i;
  const m = s.match(specialPattern);
  if (m) return m[0];
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// ---------------- single AI request (handles both SDK shapes) ----------------
async function modelCall(prompt, attempt = 1) {
  if (!API_KEY || !openai) {
    console.warn("[lrExtractor] No API key/client available: skipping AI call.");
    return "";
  }

  try {
    // chat completions older shape
    if (typeof openai.chat?.completions?.create === 'function') {
      const params = {
        model: MODEL_NAME,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 600
      };
      if (supportsSampling) params.temperature = 0;
      const resp = await openai.chat.completions.create(params);
      const choice = resp?.choices?.[0];
      const content = choice?.message?.content || choice?.text || choice?.delta?.content || "";
      return String(content || "");
    }

    // responses.create newer shape
    if (typeof openai.responses?.create === 'function') {
      const params = {
        model: MODEL_NAME,
        input: prompt,
        max_output_tokens: 600
      };
      if (supportsSampling) params.temperature = 0;
      const resp = await openai.responses.create(params);

      // extract text robustly
      let text = '';
      if (resp.output && Array.isArray(resp.output)) {
        for (const item of resp.output) {
          if (item.content && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (typeof c.text === 'string') text += c.text;
              if (Array.isArray(c.parts)) text += c.parts.join('');
              if (typeof c === 'string') text += c;
            }
          } else if (typeof item === 'string') {
            text += item;
          }
        }
      }
      if (!text) text = resp.output_text || resp.outputText || '';
      return String(text || '');
    }

    console.warn("[lrExtractor] openai SDK shape unrecognized; skipping AI call.");
    return "";
  } catch (err) {
    // log errors
    console.error("[lrExtractor] AI call error (attempt):", attempt, err && err.message ? err.message : err);
    if (err && err.response && err.response.data) {
      try { console.error("[lrExtractor] AI error response data:", JSON.stringify(err.response.data)); } catch(e){}
    }
    return "";
  }
}

// ---------------- Public API: extractDetails ----------------
async function extractDetails(message) {
  console.log("[lrExtractor] extractDetails called. Snippet:", String(message||'').slice(0,300).replace(/\n/g,' | '));
  if (!message) return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };

  const basePrompt = buildStrictPrompt(message);
  let aiText = "";
  let parsed = null;

  // Try up to 3 attempts. Each attempt we append a short note to be stricter.
  for (let i=1; i<=3; i++) {
    const prompt = (i === 1) ? basePrompt : (basePrompt + `\n\nIMPORTANT (Attempt ${i}): If you failed to return JSON previously, return ONLY the JSON object now with no extra text.`);
    aiText = await modelCall(prompt, i);

    if (!aiText) {
      console.warn(`[lrExtractor] Model returned empty on attempt ${i}.`);
      continue; // try next attempt
    }

    parsed = tryParseJsonFromText(aiText);
    if (parsed && typeof parsed === 'object') {
      // ensure all fields exist
      parsed.truckNumber = safeString(parsed.truckNumber || "");
      parsed.from = safeString(parsed.from || "");
      parsed.to = safeString(parsed.to || "");
      parsed.weight = safeString(parsed.weight || "");
      parsed.description = safeString(parsed.description || "");
      parsed.name = safeString(parsed.name || "");

      // normalize truck
      parsed.truckNumber = normalizeTruckNumber(parsed.truckNumber);
      console.log("[lrExtractor] Parsed result (from model) on attempt", i, parsed);
      return parsed;
    } else {
      console.warn(`[lrExtractor] Model returned unparsable/non-JSON on attempt ${i}. Raw:`, String(aiText).slice(0,1000));
      // continue to next attempt
    }
  }

  // After 3 attempts: give up and return empty fields (no local extraction)
  console.warn("[lrExtractor] All attempts exhausted — returning empty fields (no local fallback).");
  return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
}

// ---------------- Public API: isStructuredLR ----------------
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
