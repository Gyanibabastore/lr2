// utils/lrExtractor.js
// LR extractor (single-call by default). Retries controlled by LR_RETRIES env var.
// Uses model specified in LR_MODEL (default gpt-4o). No local fallback — returns empty fields if model fails.

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

// Default model (override via LR_MODEL)
const MODEL_NAME = process.env.LR_MODEL || "gpt-4o";
// Number of attempts (default 1). Set LR_RETRIES env var to >1 to enable retries.
const LR_RETRIES = Number(process.env.LR_RETRIES || 1);

const supportsSampling = !(/gpt-5|o3|reasoning|reasoner/i.test(MODEL_NAME));
const safeString = v => (v === undefined || v === null) ? "" : String(v).trim();
const maskKey = k => { if(!k) return '<missing>'; const s=String(k); return s.length<=12? s : s.slice(0,6)+'...'+s.slice(-4); };
if (API_KEY) console.log("[lrExtractor] API key preview:", maskKey(API_KEY), " Model:", MODEL_NAME, "Retries:", LR_RETRIES);

// ---------------- prompt builder (user's exact requirements embedded) ----------------
function buildStrictPrompt(message) {
  const safeMessage = String(message || "").replace(/"/g, '\\"').replace(/\r/g, '\n');
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
async function modelCall(prompt) {
  if (!API_KEY || !openai) {
    console.warn("[lrExtractor] No API key/client available: skipping AI call.");
    return "";
  }
  try {
    if (typeof openai.chat?.completions?.create === 'function') {
      const params = { model: MODEL_NAME, messages: [{ role: "user", content: prompt }], max_completion_tokens: 600 };
      if (supportsSampling) params.temperature = 0;
      const resp = await openai.chat.completions.create(params);
      const choice = resp?.choices?.[0];
      return String(choice?.message?.content || choice?.text || choice?.delta?.content || "" || "");
    }

    if (typeof openai.responses?.create === 'function') {
      const params = { model: MODEL_NAME, input: prompt, max_output_tokens: 600 };
      if (supportsSampling) params.temperature = 0;
      const resp = await openai.responses.create(params);
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
    console.error("[lrExtractor] AI call error:", err && err.message ? err.message : err);
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

  // Attempt loop — by default LR_RETRIES = 1 so only one call will happen.
  for (let i=1; i<=Math.max(1, LR_RETRIES); i++) {
    // On retries we add a short note requesting strict JSON (keeps model focused)
    const prompt = (i === 1) ? basePrompt : (basePrompt + `\n\nIMPORTANT (Attempt ${i}): If you failed to return JSON previously, return ONLY the JSON object now with no extra text.`);

    aiText = await modelCall(prompt);

    if (!aiText) {
      console.warn(`[lrExtractor] Model returned empty on attempt ${i}.`);
      // If LR_RETRIES==1, loop ends and we return empty fields below.
      continue;
    }

    parsed = tryParseJsonFromText(aiText);
    if (parsed && typeof parsed === 'object') {
      // ensure all fields exist, normalize truck
      parsed.truckNumber = safeString(parsed.truckNumber || "");
      parsed.from = safeString(parsed.from || "");
      parsed.to = safeString(parsed.to || "");
      parsed.weight = safeString(parsed.weight || "");
      parsed.description = safeString(parsed.description || "");
      parsed.name = safeString(parsed.name || "");

      parsed.truckNumber = normalizeTruckNumber(parsed.truckNumber);
      console.log("[lrExtractor] Parsed result (from model) on attempt", i, parsed);
      return parsed; // RETURN IMMEDIATELY — no more calls
    } else {
      console.warn(`[lrExtractor] Model returned unparsable/non-JSON on attempt ${i}. Raw:`, String(aiText).slice(0,1000));
      // continue only if LR_RETRIES > 1
    }
  }

  // After attempts exhausted, return empty fields (no local fallback per user's request)
  console.warn("[lrExtractor] Attempts exhausted — returning empty fields (no local fallback).");
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
