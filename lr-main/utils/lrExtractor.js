// utils/lrExtractor.js
// OpenAI-based LR extractor that mirrors the Gemini behaviour & post-processing you provided.
// Exports: extractDetails(message) and isStructuredLR(message)

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

// ---------------- Build the prompt (your Gemini prompt verbatim) ----------------
function buildStrictPrompt(message) {
  const safeMessage = String(message || "").replace(/"/g, '\\"').replace(/\r/g, '\n');
  return `
You are a smart logistics parser.

Extract the following *mandatory* details from this message:

- truckNumber (which may be 9 or 10 characters long, possibly containing spaces or hyphens) 
  Example: "MH 09 HH 4512" should be returned as "MH09HH4512"
- to
- weight
- description

Also, extract the *optional* fields:
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
}

// ---------------- Robustly extract text from OpenAI responses ----------------
async function extractTextFromResponse(resp) {
  // resp can be the return value of chat.completions.create or responses.create
  // We try multiple common shapes.
  try {
    // chat.completions.create shape
    if (resp && resp.choices && Array.isArray(resp.choices) && resp.choices[0]) {
      const choice = resp.choices[0];
      // message content
      if (choice.message && (choice.message.content || choice.message?.content?.[0])) {
        // some SDKs: choice.message.content is string, others nested
        if (typeof choice.message.content === 'string') return choice.message.content;
        if (Array.isArray(choice.message.content)) return choice.message.content.map(c=>c.text||'').join('');
      }
      if (choice.text) return choice.text;
      if (choice.delta && choice.delta.content) return choice.delta.content;
    }

    // newer responses.create shape
    if (resp && resp.output && Array.isArray(resp.output)) {
      let out = '';
      for (const item of resp.output) {
        if (!item) continue;
        if (item.content && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (typeof c.text === 'string') out += c.text;
            else if (Array.isArray(c.parts)) out += c.parts.join('');
            else if (typeof c === 'string') out += c;
          }
        } else if (typeof item === 'string') {
          out += item;
        }
      }
      if (out) return out;
    }

    // fallback: try resp.output_text or resp.output_text
    if (resp && (resp.output_text || resp.outputText)) return resp.output_text || resp.outputText;
  } catch (e) {
    // ignore and return empty
  }
  return '';
}

// ---------------- strip common markdown/code block wrappers ----------------
function stripFormatting(text) {
  if (!text) return '';
  let t = String(text).trim();
  // remove triple backtick code fences and leading language tags
  t = t.replace(/^\s*```[\w\s]*\n?/, '');
  t = t.replace(/\n?```\s*$/, '');
  // remove leading "```json" or similar occurrences anywhere
  t = t.replace(/```json/g, '');
  // remove possible "JSON:" or "Output:" prefixes
  t = t.replace(/^[\s\S]*?{/, function(m){ // try to find first { and slice before it
    // but we only want to if there's junk before
    return m.includes('{') ? m : m;
  });
  // trim again
  t = t.trim();
  return t;
}

// ---------------- parse JSON safely ----------------
function tryParseJsonFromText(text) {
  if (!text) return null;
  let txt = String(text).trim();
  // Remove common wrappers
  txt = txt.replace(/^\ufeff/, ''); // BOM
  // If text contains markdown fences, strip them
  if (/```/.test(txt)) {
    // remove everything before first { and after last }
    const first = txt.indexOf('{');
    const last = txt.lastIndexOf('}');
    if (first >= 0 && last > first) txt = txt.slice(first, last + 1);
    txt = txt.replace(/```/g,'').trim();
  }
  // try direct parse
  try {
    const j = JSON.parse(txt);
    if (j && typeof j === 'object') return j;
  } catch (e) {
    // try to extract first {...} block
    const first = txt.indexOf('{'), last = txt.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        const sub = txt.slice(first, last + 1);
        const j2 = JSON.parse(sub);
        if (j2 && typeof j2 === 'object') return j2;
      } catch (e2) { /* fallthrough */ }
    }
  }
  return null;
}

// ---------------- normalize truck number ----------------
function normalizeTruckNumber(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  const lower = s.toLowerCase();
  const specials = ["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad"];
  for (const p of specials) if (lower.includes(p)) return p;
  // else strip non-alphanumeric and uppercase
  return s.replace(/[\s\.\-]/g, '').toUpperCase();
}

// ---------------- Capitalize helper (same as Gemini code) ----------------
function capitalize(str) {
  if (!str) return "";
  return String(str || "").toLowerCase().split(/\s+/).map(word => {
    if (!word) return '';
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).filter(Boolean).join(' ');
}

// ---------------- single model call ----------------
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
      return await extractTextFromResponse(resp);
    }

    if (typeof openai.responses?.create === 'function') {
      const params = { model: MODEL_NAME, input: prompt, max_output_tokens: 600 };
      if (supportsSampling) params.temperature = 0;
      const resp = await openai.responses.create(params);
      return await extractTextFromResponse(resp);
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

  for (let i=1; i<=Math.max(1, LR_RETRIES); i++) {
    const prompt = (i === 1) ? basePrompt : (basePrompt + `\n\nIMPORTANT (Attempt ${i}): If you failed to return JSON previously, return ONLY the JSON object now with no extra text.`);
    aiText = await modelCall(prompt);

    if (!aiText) {
      console.warn(`[lrExtractor] Model returned empty on attempt ${i}.`);
      continue;
    }

    // strip formatting and attempt parse
    let cleaned = stripFormatting(aiText);
    parsed = tryParseJsonFromText(cleaned);

    if (parsed && typeof parsed === 'object') {
      // bring to shape & post-process (match your Gemini code)
      // ensure fields exist
      parsed.truckNumber = safeString(parsed.truckNumber || "");
      parsed.from = safeString(parsed.from || "");
      parsed.to = safeString(parsed.to || "");
      parsed.weight = safeString(parsed.weight || "");
      parsed.description = safeString(parsed.description || "");
      parsed.name = safeString(parsed.name || "");

      // If truckNumber empty, check message for special phrases (same logic as your Gemini code)
      if (!parsed.truckNumber) {
        const lowerMsg = String(message).toLowerCase();
        if (lowerMsg.includes("new truck")) parsed.truckNumber = "new truck";
        else if (lowerMsg.includes("new tractor")) parsed.truckNumber = "new tractor";
        else if (lowerMsg.includes("new gadi")) parsed.truckNumber = "new gadi";
        else if (lowerMsg.includes("bellgadi")) parsed.truckNumber = "bellgadi";
        else if (lowerMsg.includes("bellgada")) parsed.truckNumber = "bellgada";
        else if (lowerMsg.includes("bellgade")) parsed.truckNumber = "bellgade";
        else if (lowerMsg.includes("bellgad")) parsed.truckNumber = "bellgad";
      }

      // Normalize truckNumber if not special phrase
      const lowerTruck = String(parsed.truckNumber || "").toLowerCase();
      if (parsed.truckNumber && !["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad"].includes(lowerTruck)) {
        parsed.truckNumber = parsed.truckNumber.replace(/[\s\.\-]/g, '').toUpperCase();
      }

      // Capitalize from/to/description/name
      if (parsed.from) parsed.from = capitalize(parsed.from);
      if (parsed.to) parsed.to = capitalize(parsed.to);
      if (parsed.description) parsed.description = capitalize(parsed.description);
      if (parsed.name) parsed.name = capitalize(parsed.name);

      // Weight handling: mirror Gemini logic exactly
      if (parsed.weight) {
        if (/fix/i.test(parsed.weight)) {
          parsed.weight = parsed.weight.trim();
        } else {
          // Try to parse a float out of the weight string
          const numMatch = String(parsed.weight).trim().match(/-?\d+(\.\d+)?/);
          if (numMatch) {
            const weightNum = parseFloat(numMatch[0]);
            if (!isNaN(weightNum)) {
              if (weightNum > 0 && weightNum < 100) {
                // multiply by 1000 and round (same as Gemini)
                parsed.weight = Math.round(weightNum * 1000).toString();
              } else {
                parsed.weight = Math.round(weightNum).toString();
              }
            } else {
              parsed.weight = parsed.weight.trim();
            }
          } else {
            parsed.weight = parsed.weight.trim();
          }
        }
      }

      console.log("[lrExtractor] Parsed result (from model) on attempt", i, parsed);
      return parsed;
    } else {
      console.warn(`[lrExtractor] Model returned unparsable/non-JSON on attempt ${i}. Raw:`, String(aiText).slice(0,1000));
      // continue if retries allowed
    }
  }

  console.warn("[lrExtractor] Attempts exhausted — returning empty fields (no local fallback).");
  return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
}

// ---------------- Public API: isStructuredLR ----------------
async function isStructuredLR(message) {
  try {
    const d = await extractDetails(message);
    if (!d) return false;
    return Boolean(d && d.truckNumber && d.to && d.weight && d.description);
  } catch (e) {
    console.error("[lrExtractor] isStructuredLR error:", e && e.message ? e.message : e);
    return false;
  }
}

module.exports = { extractDetails, isStructuredLR };
