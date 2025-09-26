// utils/lrExtractor.js
// Gemini-only LR extractor with hardened prompt, model discovery, rate-limit respect.
// Exports: extractDetails(message) and isStructuredLR(message)

const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- API key: prefer env var; if you want inline default, replace the empty string or put your key.
// SECURITY: recommended to set process.env.GEMINI_API_KEY instead of hardcoding.
const API_KEY = "AIzaSyDCpWBb1e9rWrxELhM2ieqtH9ZNqLXKiPc";

// Preferred model order (first available will be selected)
const PREFERRED_MODELS = [
  "models/gemini-2.0-flash",
  "models/gemini-1.5-flash",
  "models/gemini-1.5-pro",
  "models/gemini-1.5"
];

let SELECTED_MODEL = null;
let modelDiscoveryTried = false;
let rateLimitResetTs = 0;

if (!API_KEY) {
  console.warn("[lrExtractor] WARNING: No GEMINI API key found. Set process.env.GEMINI_API_KEY.");
}

const genAI = new GoogleGenerativeAI(API_KEY);

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

// try extract JSON object from messy AI text
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
        .replace(/'/g, '"') // single -> double quotes
        .replace(/,(\s*[}\]])/g, "$1"); // remove trailing commas
      return JSON.parse(safe);
    } catch (e2) {
      return null;
    }
  }
}

// ----------------- Model discovery -----------------
async function ensureModelSelected() {
  if (SELECTED_MODEL || modelDiscoveryTried) return;
  modelDiscoveryTried = true;

  try {
    console.log("[lrExtractor] Discovering available models via REST...");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) {
      console.warn("[lrExtractor] listModels HTTP error:", resp.status);
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
    if (!SELECTED_MODEL) SELECTED_MODEL = available.length ? available[0] : PREFERRED_MODELS[0];
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
  // If API told us to wait earlier, skip calls until that time
  if (Date.now() < rateLimitResetTs) {
    console.warn("[lrExtractor] Skipping AI call due to prior rate-limit until", new Date(rateLimitResetTs));
    return "";
  }

  await ensureModelSelected();

  try {
    // prefer typed model client if available
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

    // Respect RetryInfo if present (common with 429)
    const retryMatch = msg.match(/"retryDelay"\s*:\s*"?([0-9.]+)\s*s"?/i) || msg.match(/Please retry in\s*([0-9.]+)s/i);
    if (retryMatch) {
      const sec = parseInt(retryMatch[1], 10);
      if (!isNaN(sec)) {
        rateLimitResetTs = Date.now() + (sec + 1) * 1000;
        console.warn(`[lrExtractor] API requested retry-after -> skipping AI until ${new Date(rateLimitResetTs)}`);
      }
    }
    return "";
  }
}

// ----------------- Hardened prompt builder -----------------
function buildStrictPrompt(message) {
  return `
You are a smart logistics parser.

Extract the following mandatory details from this message:

- truckNumber (which may be 9 or 10 characters long, possibly containing spaces or hyphens) 
  Example: "MH 09 HH 4512" should be returned as "MH09HH4512"
- to
- weight
- description

Also extract the optional fields:
- from (optional)
- name (if the message contains a pattern like "n - name", "n-name", "n. name", etc.; extract the text after the 'n' marker)

If truckNumber is missing but the message contains words like "brllgada", "bellgade", "bellgad", "bellgadi", "new truck", "new tractor", or "new gadi",
then set truckNumber to that phrase (exactly as it appears).

If the weight contains the word "fix" or similar, preserve it as-is.

Here is the message:
"""${String(message).replace(/```/g, "")}"""

Return ONLY a single valid JSON object and NOTHING ELSE. Do NOT include markdown, code fences, comments, or any extra text.

Use exactly this schema (fields must exist; use empty string "" when a field is not found):

{
  "truckNumber": "",
  "from": "",
  "to": "",
  "weight": "",
  "description": "",
  "name": ""
}
`;
}

// ----------------- Public API (Gemini-only extraction) -----------------
async function extractDetails(message) {
  const startTs = Date.now();
  console.log("[lrExtractor] extractDetails called. Message snippet:", String(message || "").slice(0,300).replace(/\n/g, ' | '));

  if (!message) {
    console.log("[lrExtractor] Empty message -> returning empty object.");
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }

  const prompt = buildStrictPrompt(message);

  // Always use AI (3 attempts)
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptNote = attempt === 0 ? "" : attempt === 1 ? "\nNOTE: Return JSON only, ensure keys exist." : "\nFINAL: If unsure, leave empty.";
    const fullPrompt = prompt + attemptNote;
    console.log(`[lrExtractor] AI attempt ${attempt+1} - sending prompt (first200):`, fullPrompt.slice(0,200).replace(/\n/g,' '));

    const aiText = await aiCallWithRateLimit(fullPrompt);
    if (!aiText) {
      console.log(`[lrExtractor] AI attempt ${attempt+1} returned empty response.`);
      continue;
    }

    console.log(`[lrExtractor] AI raw response (snippet): ${String(aiText).slice(0,800)}`);

    const parsed = tryParseJsonFromText(aiText);
    if (parsed && typeof parsed === "object") {
      console.log(`[lrExtractor] AI parsed JSON (raw):`, parsed);

      // sanitize & normalize
      const out = {
        truckNumber: parsed.truckNumber ? String(parsed.truckNumber).trim() : "",
        from: parsed.from ? String(parsed.from).trim() : "",
        to: parsed.to ? String(parsed.to).trim() : "",
        weight: parsed.weight ? String(parsed.weight).trim() : "",
        description: parsed.description ? String(parsed.description).trim() : "",
        name: parsed.name ? String(parsed.name).trim() : ""
      };

      // normalize truck unless it's a special phrase
      const specials = ["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad","brllgada"];
      if (out.truckNumber && !specials.includes(out.truckNumber.toLowerCase())) out.truckNumber = normalizeTruck(out.truckNumber);
      if (out.from) out.from = capitalize(out.from);
      if (out.to) out.to = capitalize(out.to);
      if (out.description) out.description = capitalize(out.description);
      if (out.name) out.name = capitalize(out.name);

      // weight normalization (preserve 'fix')
      if (out.weight && !/fix/i.test(out.weight)) {
        const wn = String(out.weight).replace(/,/g,"");
        const n = parseFloat(wn);
        if (!isNaN(n)) {
          if (n > 0 && n < 100) out.weight = Math.round(n * 1000).toString();
          else out.weight = Math.round(n).toString();
        }
      }

      console.log("[lrExtractor] Final parsed (from AI). Took(ms):", Date.now() - startTs, "Result:", out);
      return out;
    } else {
      console.log(`[lrExtractor] AI attempt ${attempt+1} produced unparseable output.`);
    }
  }

  // AI failed all attempts -> return empty fields (no fallback)
  console.warn("[lrExtractor] AI failed after attempts — returning empty fields (NO fallback).");
  return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
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
