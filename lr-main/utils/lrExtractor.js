// utils/lrExtractor.js
// AI-first LR extractor using Gemini with automatic model discovery (using your API key),
// pre-check to skip AI for structured messages, retry/backoff that respects RetryInfo,
// and deterministic fallback. Exports: extractDetails(message), isStructuredLR(message)

const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Inline API key (as provided by you) ---
const API_KEY = "AIzaSyDCpWBb1e9rWrxELhM2ieqtH9ZNqLXKiPc";

// Preferred model order (we will pick first available)
const PREFERRED_MODELS = [
  "models/gemini-2.0-flash",
  "models/gemini-1.5-flash",
  "models/gemini-1.5-pro",
  "models/gemini-1.5"
];

let SELECTED_MODEL = null; // will be set by ensureModelSelected()
let modelDiscoveryTried = false;
let rateLimitResetTs = 0; // epoch ms until which AI calls should be skipped when quota/exhausted

const genAI = new GoogleGenerativeAI(API_KEY);

// ----------------- goodsKeywords (your full list) -----------------
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
  'finishu','finisih','finis','finnish','finsh','finush','fnish','funish','plates','plate','iron','iran'
];

// ----------------- Helpers -----------------
const normalizeTruck = (s) => {
  if (!s) return "";
  return String(s).replace(/[\s\.-]/g, "").toUpperCase();
};
const capitalize = (str) => {
  if (!str) return "";
  return String(str)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
    .join(" ");
};
const parseNumberLike = (t) => {
  if (!t) return "";
  const cleaned = String(t).replace(/,/g, "").trim();
  const m = cleaned.match(/(\d+(?:\.\d+)?)/);
  return m ? m[1] : "";
};

// Extract JSON object from AI text (forgiving)
function tryParseJsonFromText(text) {
  if (!text) return null;
  const txt = String(text).trim();
  const jmatch = txt.match(/\{[\s\S]*\}/);
  if (!jmatch) return null;
  const raw = jmatch[0];
  try {
    return JSON.parse(raw);
  } catch (e) {
    try {
      let safe = raw
        .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":') // quote keys
        .replace(/'/g, '"') // single -> double
        .replace(/,(\s*[}\]])/g, "$1"); // remove trailing commas
      return JSON.parse(safe);
    } catch (e2) {
      return null;
    }
  }
}

// ----------------- Weight tokenization + heuristics -----------------
function numericTokensWithContext(text) {
  const tokens = [];
  if (!text) return tokens;
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = w.match(/([0-9]{1,7}(?:[.,][0-9]+)?)/);
    if (m) {
      const num = parseNumberLike(m[1]);
      const ctx = words.slice(Math.max(0, i - 3), Math.min(words.length, i + 4)).join(" ");
      tokens.push({ raw: w, num, index: i, context: ctx });
    }
  }
  return tokens;
}
function looksLikeTruckNumberToken(tokenRaw, fullMessage) {
  if (!tokenRaw) return false;
  const joined = fullMessage.replace(/\s+/g, "");
  if (joined.match(/[A-Za-z]{2}\d{1,2}[A-Za-z]{1,3}\d{1,4}/)) {
    if (new RegExp(`[A-Za-z]{2}\\s?\\d{1,2}\\s?[A-Za-z]{1,3}\\s?${tokenRaw}`, "i").test(fullMessage)) {
      return true;
    }
  }
  return false;
}
function pickBestWeightCandidate(message) {
  const weightWords = ["wt","weight","kg","kgs","kilogram","kilograms","ton","tons","t","mt","quintal"];
  const tokens = numericTokensWithContext(message);
  if (!tokens.length) return "";

  const nearWeight = tokens.filter(t => {
    const ctx = t.context.toLowerCase();
    for (const w of weightWords) if (ctx.includes(w)) return true;
    return false;
  }).filter(t => !looksLikeTruckNumberToken(t.raw, message));

  if (nearWeight.length) {
    nearWeight.sort((a,b) => {
      const aHasUnit = /kg|kgs|ton|mt|wt|quintal/.test(a.context.toLowerCase()) ? 1 : 0;
      const bHasUnit = /kg|kgs|ton|mt|wt|quintal/.test(b.context.toLowerCase()) ? 1 : 0;
      return (bHasUnit - aHasUnit) || (parseFloat(b.num) - parseFloat(a.num));
    });
    return nearWeight[0].num;
  }

  const withUnit = tokens.filter(t => /kg|kgs|mt|ton|t\b/.test(t.raw.toLowerCase()))
    .filter(t => !looksLikeTruckNumberToken(t.raw, message));
  if (withUnit.length) {
    withUnit.sort((a,b) => parseFloat(b.num) - parseFloat(a.num));
    return withUnit[0].num;
  }

  const large = tokens.filter(t => parseFloat(t.num || 0) >= 1000 && !looksLikeTruckNumberToken(t.raw, message));
  if (large.length) {
    large.sort((a,b) => parseFloat(b.num) - parseFloat(a.num));
    return large[0].num;
  }

  const nonTruck = tokens.filter(t => !looksLikeTruckNumberToken(t.raw, message));
  if (nonTruck.length) {
    nonTruck.sort((a,b) => parseFloat(b.num) - parseFloat(a.num));
    return nonTruck[0].num;
  }

  tokens.sort((a,b) => parseFloat(b.num) - parseFloat(a.num));
  return tokens[0].num;
}

// ----------------- Deterministic fallback parser -----------------
function fallbackParse(message) {
  const lines = String(message || "")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  let truckNumber = "";
  let from = "";
  let to = "";
  let weight = "";
  let description = "";
  let name = "";

  // Truck detection
  for (const ln of lines) {
    const m = ln.match(/([A-Za-z]{2}\s?\d{1,2}\s?[A-Za-z]{1,3}\s?\d{1,4})/);
    if (m) {
      const cand = m[1].replace(/[^A-Za-z0-9]/g, "");
      if (cand.length >= 6 && cand.length <= 10) {
        truckNumber = normalizeTruck(cand);
        break;
      }
    }
    const t2 = ln.replace(/\s/g, "");
    if (/^[A-Za-z0-9]{6,10}$/.test(t2)) {
      truckNumber = normalizeTruck(t2);
      break;
    }
  }

  // from/to
  for (const ln of lines) {
    const m = ln.match(/(.+?)\s*(?:to|->|→|–|—|-)\s*(.+)/i);
    if (m) { from = capitalize(m[1].trim()); to = capitalize(m[2].trim()); break; }
  }

  // weight using heuristics
  if (!weight) {
    const joined = lines.join(" ");
    const candidate = pickBestWeightCandidate(joined);
    if (candidate) weight = parseNumberLike(candidate);
  }

  // description
  for (const ln of lines) {
    const low = ln.toLowerCase();
    for (const kw of goodsKeywords) {
      if (low.includes(kw)) { description = capitalize(ln); break; }
    }
    if (description) break;
  }
  if (!description) {
    for (const ln of lines) {
      if (/^\d+$/.test(ln.replace(/\s/g, ""))) continue;
      if (ln.toLowerCase().includes('to') && ln.split(/\s+/).length > 2) continue;
      if (ln.length > 1 && ln.length < 160) { description = capitalize(ln); break; }
    }
  }

  // name
  for (const ln of lines) {
    const m = ln.match(/\b[nN]\s*[\-.:]?\s*(.+)$/);
    if (m) { name = capitalize(m[1].trim()); break; }
    const m2 = ln.match(/\bname\b\s*[:\-]\s*(.+)$/i);
    if (m2) { name = capitalize(m2[1].trim()); break; }
  }

  // special phrases
  const lower = String(message || "").toLowerCase();
  if (!truckNumber) {
    const specials = ['new truck','new tractor','new gadi','bellgadi','bellgada','bellgade','bellgad','brllgada'];
    for (const s of specials) if (lower.includes(s)) { truckNumber = s; break; }
  }

  return { truckNumber, from, to, weight, description, name };
}

// ----------------- Model discovery -----------------
// Attempt to list models using the REST endpoint (using API key) and pick first preferred
async function ensureModelSelected() {
  if (SELECTED_MODEL || modelDiscoveryTried) return;
  modelDiscoveryTried = true;
  try {
    console.log("[lrExtractor] Discovering available models via REST listModels...");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
    // Node 18+ has global fetch; if not available, user must polyfill
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) {
      console.warn("[lrExtractor] listModels HTTP error:", resp.status, await resp.text());
      // fallback to preferred order first item
      SELECTED_MODEL = PREFERRED_MODELS[0];
      console.log("[lrExtractor] Falling back to default model:", SELECTED_MODEL);
      return;
    }
    const body = await resp.json();
    const available = (body.models || []).map(m => m.name || m.model || m.id).filter(Boolean);
    console.log("[lrExtractor] Available models:", available);
    for (const pref of PREFERRED_MODELS) {
      if (available.includes(pref)) {
        SELECTED_MODEL = pref;
        break;
      }
    }
    if (!SELECTED_MODEL) {
      // pick first available or fallback to first preferred
      SELECTED_MODEL = available.length ? available[0] : PREFERRED_MODELS[0];
    }
    console.log("[lrExtractor] Selected model:", SELECTED_MODEL);
  } catch (e) {
    console.error("[lrExtractor] model discovery failed:", e && e.message ? e.message : e);
    SELECTED_MODEL = PREFERRED_MODELS[0];
    console.log("[lrExtractor] Falling back to default model:", SELECTED_MODEL);
  }
}

// ----------------- Low-level AI call with rate-limit respect -----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function aiCallWithRateLimit(prompt) {
  // If server previously told us to wait, skip AI call
  if (Date.now() < rateLimitResetTs) {
    console.warn("[lrExtractor] Skipping AI call due to rate-limit until", new Date(rateLimitResetTs));
    return "";
  }

  // ensure we have selected a model
  await ensureModelSelected();

  // Prepare call using genAI + selected model
  try {
    const modelObj = genAI.getGenerativeModel ? genAI.getGenerativeModel({ model: SELECTED_MODEL }) : null;
    if (modelObj && typeof modelObj.generateContent === "function") {
      const result = await modelObj.generateContent(prompt, { temperature: 0, maxOutputTokens: 512 });
      return result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }
    if (typeof genAI.generate === "function") {
      const resp = await genAI.generate({ prompt, temperature: 0, maxOutputTokens: 512, model: SELECTED_MODEL });
      return resp?.text || "";
    }
    return "";
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("[lrExtractor] aiCall error:", msg);

    // try to extract retryDelay from error message
    const retryMatch = msg.match(/"retryDelay"\s*:\s*"?(\d+)\s*s"?/i) || msg.match(/Please retry in\s*([0-9.]+)s/i);
    if (retryMatch) {
      const sec = parseInt(retryMatch[1], 10);
      if (!isNaN(sec)) {
        rateLimitResetTs = Date.now() + (sec + 1) * 1000;
        console.warn(`[lrExtractor] API returned RetryInfo -> skipping AI until ${new Date(rateLimitResetTs)}`);
      }
    }
    return "";
  }
}

// ----------------- Quick structured-check to avoid AI (saves quota) -----------------
function looksStructuredFast(msg) {
  if (!msg) return false;
  const lc = msg.toLowerCase();
  const hasWeightToken = /(wt|weight|kgs?|kg|mt|ton)/.test(lc);
  const hasPlate = /[A-Za-z]{2}\s?\d{1,2}\s?[A-Za-z]{1,3}\s?\d{1,4}/.test(msg);
  const hasWtNum = /(wt|weight)\s*[:\-]?\s*[0-9]{2,7}/i.test(msg);
  return hasWeightToken && (hasPlate || hasWtNum);
}

// ----------------- Prompt builder (strict) -----------------
function buildStrictPrompt(message) {
  return `
You are a reliable logistics parser. Extract exactly ONE JSON object and NOTHING ELSE with these keys:
"truckNumber","from","to","weight","description","name"

Rules:
- truckNumber: return Indian plate normalized (no spaces/dashes, uppercase) if present (e.g., "MH09HH4512"). If missing but message contains phrases like "new truck","new gadi","bellgadi", return that phrase as truckNumber.
- weight: prefer numbers closest to tokens: wt, weight, kg, kgs, mt, ton. If value <100 treat as tons and multiply by 1000. If it contains "fix" or non-numeric preserve as-is.
- description: short human-readable goods line (capitalize each word).
- If any field not found, set it to empty string "".
- Reply with JSON only (no markdown, no explanation).

Message:
"""${String(message).replace(/```/g,"")}"""
`;
}

// ----------------- Public API -----------------
async function extractDetails(message) {
  const startTs = Date.now();
  console.log("[lrExtractor] extractDetails called. Message snippet:", String(message || "").slice(0,300).replace(/\n/g, ' | '));
  if (!message) {
    console.log("[lrExtractor] Empty message -> returning empty object.");
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }

  // Quick structured check -> fallback skip AI
  if (looksStructuredFast(message)) {
    console.log("[lrExtractor] Message appears structured -> skipping AI and using fallbackParse");
    const fb = fallbackParse(message);
    // Normalize fallback fields (same normalization as AI path)
    const specials = ["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad","brllgada"];
    if (fb.truckNumber && !specials.includes(fb.truckNumber.toLowerCase())) fb.truckNumber = normalizeTruck(fb.truckNumber);
    if (fb.from) fb.from = capitalize(fb.from);
    if (fb.to) fb.to = capitalize(fb.to);
    if (fb.description) fb.description = capitalize(fb.description);
    if (fb.name) fb.name = capitalize(fb.name);
    if (fb.weight && !/fix/i.test(fb.weight)) {
      const wn2 = String(fb.weight).replace(/,/g,"");
      const n2 = parseFloat(wn2);
      if (!isNaN(n2)) {
        if (n2 > 0 && n2 < 100) fb.weight = Math.round(n2 * 1000).toString();
        else fb.weight = Math.round(n2).toString();
      }
    }
    console.log("[lrExtractor] Final parsed (fallback-fast). Took(ms):", Date.now()-startTs, "Result:", fb);
    return fb;
  }

  const promptBase = buildStrictPrompt(message);

  // try AI up to 3 attempts with small nudges but using aiCallWithRateLimit
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptNote = attempt === 0 ? "" : attempt === 1 ? "\nNOTE: Return JSON only, ensure keys exist." : "\nFINAL: If unsure, leave empty.";
    const prompt = promptBase + attemptNote;
    console.log(`[lrExtractor] AI attempt ${attempt+1} - sending prompt (first 200 chars):`, prompt.slice(0,200).replace(/\n/g,' '));
    const aiText = await aiCallWithRateLimit(prompt);
    if (!aiText) {
      console.log(`[lrExtractor] AI attempt ${attempt+1} returned empty response.`);
      continue;
    }
    console.log(`[lrExtractor] AI raw response (snippet 0..800): ${String(aiText).slice(0,800)}`);

    // try to parse JSON out of aiText
    const parsed = tryParseJsonFromText(aiText);
    if (parsed && typeof parsed === "object") {
      console.log(`[lrExtractor] AI parsed JSON (raw):`, parsed);
      // sanitize and normalize fields
      const out = {
        truckNumber: parsed.truckNumber ? String(parsed.truckNumber).trim() : "",
        from: parsed.from ? String(parsed.from).trim() : "",
        to: parsed.to ? String(parsed.to).trim() : "",
        weight: parsed.weight ? String(parsed.weight).trim() : "",
        description: parsed.description ? String(parsed.description).trim() : "",
        name: parsed.name ? String(parsed.name).trim() : ""
      };

      // Normalize truck unless it's one of the special phrases
      const specials = ["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad","brllgada"];
      if (out.truckNumber && !specials.includes(out.truckNumber.toLowerCase())) {
        out.truckNumber = normalizeTruck(out.truckNumber);
      }

      // Capitalize human fields
      if (out.from) out.from = capitalize(out.from);
      if (out.to) out.to = capitalize(out.to);
      if (out.description) out.description = capitalize(out.description);
      if (out.name) out.name = capitalize(out.name);

      // Weight normalization (preserve 'fix')
      if (out.weight && !/fix/i.test(out.weight)) {
        const wn = String(out.weight).replace(/,/g,"");
        const n = parseFloat(wn);
        if (!isNaN(n)) {
          if (n > 0 && n < 100) out.weight = Math.round(n * 1000).toString();
          else out.weight = Math.round(n).toString();
        } else {
          out.weight = out.weight;
        }
      }

      const took = Date.now() - startTs;
      console.log("[lrExtractor] Final parsed (from AI). Took(ms):", took, "Result:", out);
      return out;
    } else {
      console.log(`[lrExtractor] AI attempt ${attempt+1} didn't return parseable JSON. Raw returned but parse failed.`);
    }
  }

  // if AI failed all attempts -> use fallback
  console.warn("[lrExtractor] AI failed to produce valid JSON after attempts — running deterministic fallback.");
  const fb = fallbackParse(message);

  // Normalize fallback
  if (fb.truckNumber && !["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad","brllgada"].includes(fb.truckNumber.toLowerCase())) {
    fb.truckNumber = normalizeTruck(fb.truckNumber);
  }
  if (fb.from) fb.from = capitalize(fb.from);
  if (fb.to) fb.to = capitalize(fb.to);
  if (fb.description) fb.description = capitalize(fb.description);
  if (fb.name) fb.name = capitalize(fb.name);
  if (fb.weight && !/fix/i.test(fb.weight)) {
    const wn2 = String(fb.weight).replace(/,/g,"");
    const n2 = parseFloat(wn2);
    if (!isNaN(n2)) {
      if (n2 > 0 && n2 < 100) fb.weight = Math.round(n2 * 1000).toString();
      else fb.weight = Math.round(n2).toString();
    }
  }

  const took2 = Date.now() - startTs;
  console.log("[lrExtractor] Final parsed (from fallback). Took(ms):", took2, "Result:", fb);
  return fb;
}

async function isStructuredLR(message) {
  try {
    const d = await extractDetails(message);
    return Boolean(d.truckNumber && d.to && d.weight && d.description);
  } catch (e) {
    console.error("[lrExtractor] isStructuredLR error:", e && e.message ? e.message : e);
    return false;
  }
}

module.exports = { extractDetails, isStructuredLR };
