// utils/lrExtractor.js
// ChatGPT (gpt-5-mini) single-call LR extractor (patched to remove temperature=0).
// Exports: extractDetails(message) and isStructuredLR(message)

'use strict';

try { require('dotenv').config(); } catch (e) { /* ignore */ }

const OpenAI = require('openai');

// --- sanitize & load key from GEMINI_API_KEY (per your env) ---
function cleanKey(k) {
  if (!k) return '';
  return String(k).trim().replace(/^["'=]+|["']+$/g, '');
}
function maskKey(k) {
  if (!k) return '<missing>';
  const s = String(k);
  if (s.length <= 12) return s;
  return s.slice(0, 6) + '...' + s.slice(-4);
}

const RAW_KEY = process.env.GEMINI_API_KEY || '';
const API_KEY = cleanKey(RAW_KEY);

if (!API_KEY) {
  console.warn("[lrExtractor] WARNING: No API key found. Set process.env.GEMINI_API_KEY.");
} else {
  console.log("[lrExtractor] GEMINI_API_KEY preview:", maskKey(API_KEY));
}

let openai = null;
if (API_KEY) {
  try {
    openai = new OpenAI({ apiKey: API_KEY });
  } catch (e) {
    console.warn("[lrExtractor] Failed to create OpenAI client:", e && e.message ? e.message : e);
  }
}

const MODEL_NAME = "gpt-5-mini";

// safe trimming
const safeString = (v) => (v === undefined || v === null) ? "" : String(v).trim();

// try to parse JSON blob from model text output
function tryParseJsonFromText(text) {
  if (!text) return null;
  const txt = String(text).trim();

  // direct parse
  try {
    const maybe = JSON.parse(txt);
    if (maybe && typeof maybe === 'object') return maybe;
  } catch (e) { /* ignore */ }

  // first {...} block
  const firstBrace = txt.indexOf('{');
  const lastBrace = txt.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const raw = txt.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(raw);
    } catch (e) {
      try {
        const safe = raw
          .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
          .replace(/(['`])([^'`]*?)\1/g, function(_,qd,inner){ return JSON.stringify(inner); })
          .replace(/:\s*([A-Za-z0-9\-\_\.]+)([,\n\r}])/g, function(_,v,post){
            if (/^[-]?\d+(\.\d+)?$/.test(v)) return ':' + v + post;
            if (/^(true|false|null)$/i.test(v)) return ':' + v + post;
            return ':' + JSON.stringify(v) + post;
          })
          .replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(safe);
      } catch (e2) {
        return null;
      }
    }
  }

  // greedy fallback
  const jmatch = txt.match(/\{[\s\S]*\}/);
  if (!jmatch) return null;
  try {
    return JSON.parse(jmatch[0]);
  } catch (e) {
    return null;
  }
}

// Post-process truck number to match example: remove non-alphanumerics and uppercase
function normalizeTruckNumber(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  const specialPattern = /\b(brllgada|bellgade|bellgad|bellgadi|new truck|new tractor|new gadi)\b/i;
  if (specialPattern.test(s)) {
    const m = s.match(specialPattern);
    return m ? m[0] : s;
  }
  const cleaned = s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned;
}

// Build user's custom prompt (inserts message safely)
function buildUserPrompt(message) {
  const safeMessage = String(message || "").replace(/"/g, '\\"').replace(/\r/g, '\n');
  const prompt = `
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

Return the extracted information strictly in the following JSON format:

{
  "truckNumber": "",    // mandatory
  "from": "",           // optional
  "to": "",             // mandatory
  "weight": "",         // mandatory
  "description": "",    // mandatory
  "name": ""            // optional
}

If any field is missing, return it as an empty string.

Ensure the output is only the raw JSON — no extra text, notes, or formatting outside the JSON structure.
`.trim();
  return prompt;
}

// Single AI call supporting multiple SDK shapes
async function singleAiCall(prompt) {
  if (!API_KEY || !openai) {
    console.warn("[lrExtractor] No API key/client available: skipping AI call.");
    return "";
  }

  try {
    // Older SDK shape
    if (typeof openai.chat?.completions?.create === 'function') {
      const resp = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages: [{ role: "user", content: prompt }],
        // use max_completion_tokens for SDKs rejecting max_tokens
        max_completion_tokens: 600
        // no temperature provided — allow model default
      });
      const choice = resp?.choices?.[0];
      const content = choice?.message?.content || choice?.text || choice?.delta?.content || "";
      return String(content || "");
    }

    // Newer SDK shape
    if (typeof openai.responses?.create === 'function') {
      const resp = await openai.responses.create({
        model: MODEL_NAME,
        input: prompt,
        max_output_tokens: 600
        // no temperature provided — allow model default
      });

      let text = '';
      try {
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
      } catch (e) {
        text = text || resp.output_text || resp.outputText || '';
      }

      if (!text && resp.output_text) text = resp.output_text;
      if (!text && resp.outputText) text = resp.outputText;

      return String(text || '');
    }

    console.warn("[lrExtractor] openai SDK shape unrecognized; skipping AI call.");
    return "";
  } catch (err) {
    console.error("[lrExtractor] AI call error:", err && err.message ? err.message : String(err));
    if (err && err.response && err.response.data) {
      try { console.error("[lrExtractor] AI error response data:", JSON.stringify(err.response.data)); } catch(e){}
    } else if (err && err.statusCode) {
      console.error("[lrExtractor] AI error statusCode:", err.statusCode);
    }
    return "";
  }
}

async function extractDetails(message) {
  const startTs = Date.now();
  console.log("[lrExtractor] extractDetails called. Snippet:", String(message || "").slice(0,300).replace(/\n/g, ' | '));

  if (!message) {
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }

  const prompt = buildUserPrompt(message);

  // single AI call
  const aiText = await singleAiCall(prompt);
  if (!aiText) {
    console.warn("[lrExtractor] AI returned empty response -> returning empty fields.");
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }

  // parse JSON
  const parsed = tryParseJsonFromText(aiText);
  if (parsed && typeof parsed === "object") {
    // Extract fields safely
    const rawTruck = safeString(parsed.truckNumber);
    const from = safeString(parsed.from);
    const to = safeString(parsed.to);
    const weight = safeString(parsed.weight);
    const description = safeString(parsed.description);
    const name = safeString(parsed.name);

    // Post-process truck number according to user's example
    const normalizedTruck = normalizeTruckNumber(rawTruck || '');

    const out = {
      truckNumber: normalizedTruck,
      from,
      to,
      weight,
      description,
      name
    };

    console.log("[lrExtractor] Parsed result (took ms):", Date.now() - startTs, out);
    return out;
  }

  console.warn("[lrExtractor] Could not parse JSON from AI output -> returning empty fields. Raw AI text:", aiText.slice(0,1000));
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
