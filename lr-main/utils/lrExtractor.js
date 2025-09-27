// utils/lrExtractor.js
// OpenAI-based LR extractor that mirrors the Gemini behaviour & post-processing you provided.
// Behavior: RELY on model for most fields but:
//  - If message contains origin-destination patterns (e.g., "Indore to Nagpur", "Indore se Nagpur", "Indore - Nagpur"),
//    place the first part into `from` and the second into `to` (if model didn't already provide `from`).
//  - Do NOT use model's `description`. Instead extract description only from the provided goodsKeywords list
//    (first match(es) in message). If none matched, description remains empty.
// Added: verbose console logging of raw model response + cleaned text + parsing result.
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

// ---------------- goods keywords (use exactly these for description extraction) ----------------
const goodsKeywords = [
  'aluminium section','angel channel','battery scrap','finish goods','paper scrap','shutter material',
  'iron scrap','metal scrap','ms plates','ms scrap','machine scrap','plastic dana','plastic scrap',
  'rubber scrap','pushta scrap','rolling scrap','tmt bar','tarafa','metal screp','plastic screp',
  'plastic scrp','plastic secrap','raddi scrap','pusta scrap','allminium scrap',
  'ajwain','ajvain','aluminium','alluminium','allumium','alluminum','aluminum','angel','angal',
  'battery','battrey','cement','siment','chaddar','chadar','chader','churi','chhuri','choori',
  'coil','sheet','sheets','drum','dram','drums','finish','fenish','paper','shutter','shuttar',
  'haldi','haaldi','oil','taraba','tarafe','tarama','tarana','tarapa','tarfa','trafa','machine',
  'pipe','pip','plastic','pilastic','pladtic','plastec','plastick','plastics','plastik','rubber',
  'rubar','rabar','ruber','pusta','steel','isteel','steels','stel','sugar','tubes','tyre','tayar',
  'tyer','scrap','screp','dana','pushta','rolling','tmt','bar','loha','pusta','tilli','tili',
  'finishu','finisih','finis','finnish','finsh','finush','fnish','funish','plates','plate','iron','iran',
];

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
  try {
    if (resp && resp.choices && Array.isArray(resp.choices) && resp.choices[0]) {
      const choice = resp.choices[0];
      if (choice.message && (choice.message.content || choice.message?.content?.[0])) {
        if (typeof choice.message.content === 'string') return choice.message.content;
        if (Array.isArray(choice.message.content)) return choice.message.content.map(c=>c.text||'').join('');
      }
      if (choice.text) return choice.text;
      if (choice.delta && choice.delta.content) return choice.delta.content;
    }

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

    if (resp && (resp.output_text || resp.outputText)) return resp.output_text || resp.outputText;
  } catch (e) {
    // ignore
  }
  return '';
}

// ---------------- strip common markdown/code block wrappers ----------------
function stripFormatting(text) {
  if (!text) return '';
  let t = String(text).trim();
  // remove triple backtick fences
  t = t.replace(/^\s*```[\w\s]*\n?/, '');
  t = t.replace(/\n?```\s*$/, '');
  // remove ```json labels
  t = t.replace(/```json/g, '');
  // Try to keep only the JSON block if there is pre/post text
  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    t = t.slice(firstBrace, lastBrace + 1);
  }
  return t.trim();
}

// ---------------- parse JSON safely ----------------
function tryParseJsonFromText(text) {
  if (!text) return null;
  let txt = String(text).trim();
  txt = txt.replace(/^\ufeff/, ''); // BOM
  try {
    const j = JSON.parse(txt);
    if (j && typeof j === 'object') return j;
  } catch (e) {
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
  return s.replace(/[\s\.\-]/g, '').toUpperCase();
}

// ---------------- Capitalize helper ----------------
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

// ---------------- find goods keywords in message (returns array in order found) ----------------
function findGoodsInMessage(message) {
  if (!message) return [];
  const lower = message.toLowerCase();
  const found = [];
  for (const kw of goodsKeywords) {
    // build a safe regex: escape special chars in kw
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + esc + '\\b', 'i');
    if (re.test(lower) && !found.includes(kw)) {
      found.push(kw);
    }
  }
  return found;
}

// ---------------- origin-destination detection from raw message (safer) ----------------
function detectOriginDestinationFromMessage(message) {
  if (!message) return null;
  const m = String(message).trim();

  // helper: decide if a text is likely a LOCATION (not weight/desc)
  function isLikelyLocation(s) {
    if (!s) return false;
    const lower = s.toLowerCase();

    // reject if contains explicit weight/unit tokens or phone-like patterns
    if (/\b(kg|kgs|kilogram|kilograms|ton|tons|tonne|mt\b|mton|t\b|kgs\b|kg\b|gms?|gm\b)\b/i.test(lower)) return false;
    if (/\b\d{3,}\b/.test(lower) && !/[a-zA-Z]/.test(lower)) return false; // pure long numbers -> not location
    if (/\b\d{2,}[\s-]*kg\b/i.test(lower)) return false;

    // reject if contains goods keywords (we treat those as description)
    for (const kw of goodsKeywords) {
      if (lower.includes(kw)) return false;
    }

    // phone number like
    if (/\b\d{6,}\b/.test(lower) && /[a-zA-Z]/.test(lower) === false) return false;

    // letters vs digits heuristic: need reasonable letters count
    const letters = (s.match(/[a-zA-Z\u00C0-\u017F]/g) || []).length;
    const digits = (s.match(/\d/g) || []).length;
    if (letters < 3) return false; // too short or not enough letters -> likely not a place
    // if digits dominate letters, probably not a location (e.g., "7300 kg")
    if (digits > letters) return false;

    return true;
  }

  // regex patterns to try (same as before, but we'll validate parts)
  const odRegexes = [
    /([A-Za-z0-9\u00C0-\u017F &\.\']{2,}?)\s+(?:to)\s+([A-Za-z0-9\u00C0-\u017F &\.\']{2,})/i,
    /([A-Za-z0-9\u00C0-\u017F &\.\']{2,}?)\s+(?:se)\s+([A-Za-z0-9\u00C0-\u017F &\.\']{2,})/i,
    /([A-Za-z0-9\u00C0-\u017F &\.\']{2,}?)\s*[-–—]+\s*([A-Za-z0-9\u00C0-\u017F &\.\']{2,})/i,
    /([A-Za-z0-9\u00C0-\u017F &\.\']{2,}?)\s*->\s*([A-Za-z0-9\u00C0-\u017F &\.\']{2,})/i
  ];

  for (const rx of odRegexes) {
    const match = m.match(rx);
    if (match && match[1] && match[2]) {
      let origin = match[1].trim();
      let dest = match[2].trim();

      // strip surrounding punctuation
      origin = origin.replace(/^[\:\-]+|[\:\-]+$/g,'').trim();
      dest = dest.replace(/^[\:\-]+|[\:\-]+$/g,'').trim();

      const originOk = isLikelyLocation(origin);
      const destOk = isLikelyLocation(dest);

      if (originOk && destOk) {
        return { origin, dest };
      } else {
        // log rejection reason
        console.log(`[lrExtractor] OD-detect rejected: originOk=${originOk}, destOk=${destOk}, origin='${origin}', dest='${dest}'`);
        // continue to try other patterns
      }
    }
  }

  return null;
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

    // ---- call model ----
    aiText = await modelCall(prompt);

    // ---- LOG: raw model response ----
    console.log(`\n[lrExtractor] Raw model response (attempt ${i}):\n${aiText}\n`);

    if (!aiText) {
      console.warn(`[lrExtractor] Model returned empty on attempt ${i}.`);
      continue;
    }

    // ---- LOG: cleaned (stripped) text ----
    const cleaned = stripFormatting(aiText);
    console.log(`[lrExtractor] Cleaned response (attempt ${i}):\n${cleaned}\n`);

    // ---- try parse ----
    parsed = tryParseJsonFromText(cleaned);

    if (parsed && typeof parsed === 'object') {
      // RELY on model for most fields but override description from message goodsKeywords
      parsed.truckNumber = safeString(parsed.truckNumber || "");
      parsed.from = safeString(parsed.from || "");
      parsed.to = safeString(parsed.to || "");
      parsed.weight = safeString(parsed.weight || "");
      // DO NOT use parsed.description from model - replace based on goodsKeywords in message.
      parsed.description = "";
      parsed.name = safeString(parsed.name || "");

      // If truckNumber empty, check message for special phrases
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

      // ===== NEW: If parsed.from empty, try to detect origin-destination from raw message (e.g., "Manavar to Indore") =====
      if ((!parsed.from || parsed.from.trim() === "") ) {
        const od = detectOriginDestinationFromMessage(message);
        if (od) {
          parsed.from = od.origin;
          parsed.to = od.dest || parsed.to;
          console.log(`[lrExtractor] Local OD detection from message -> from='${parsed.from}', to='${parsed.to}'`);
        }
      }

      // Capitalize fields (cosmetic)
      if (parsed.from) parsed.from = capitalize(parsed.from);
      if (parsed.to) parsed.to = capitalize(parsed.to);

      // ===== NEW: Extract description ONLY from goodsKeywords present in message (do NOT use model's description) =====
      const foundGoods = findGoodsInMessage(message);
      if (foundGoods && foundGoods.length > 0) {
        // join unique found goods (preserve order) and capitalize each
        const uniqueGoods = [...new Set(foundGoods)];
        parsed.description = uniqueGoods.map(g => capitalize(g)).join(', ');
        console.log(`[lrExtractor] Description set from message goods keywords: ${parsed.description}`);
      } else {
        parsed.description = ""; // explicit: no description if goods keywords not found
        console.log(`[lrExtractor] No goods keywords found in message -> description left empty.`);
      }

      // Weight handling (mirror Gemini behavior): keep 'fix' etc; else parse numeric and convert
      if (parsed.weight) {
        if (/fix/i.test(parsed.weight)) {
          parsed.weight = parsed.weight.trim();
        } else {
          const numMatch = String(parsed.weight).trim().match(/-?\d+(\.\d+)?/);
          if (numMatch) {
            const weightNum = parseFloat(numMatch[0]);
            if (!isNaN(weightNum)) {
              if (weightNum > 0 && weightNum < 100) {
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

      // Name capitalization
      if (parsed.name) parsed.name = capitalize(parsed.name);

      console.log("[lrExtractor] Parsed result (from model + local overrides) on attempt", i, parsed);

      // LOG if mandatory fields missing in model output — for visibility
      if (!parsed.truckNumber) console.warn("[lrExtractor] NOTE: model did not return truckNumber.");
      if (!parsed.to) console.warn("[lrExtractor] NOTE: model did not return 'to'.");
      if (!parsed.weight) console.warn("[lrExtractor] NOTE: model did not return 'weight'.");
      if (!parsed.description) console.warn("[lrExtractor] NOTE: description empty (no goods keywords found in message).");

      return parsed;
    } else {
      console.warn(`[lrExtractor] Model returned unparsable/non-JSON on attempt ${i}. Raw cleaned text shown above.`);
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
