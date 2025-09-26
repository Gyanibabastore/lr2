// utils/lrExtractor.js
// AI-first LR extractor with fallback (ready-to-paste).
// Exports: extractDetails(message) and isStructuredLR(message)

const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Inline API key as requested ---
const API_KEY = "AIzaSyBTt-wdj0YsByntwscggZ0dDRzrc7Qmc7I";
const MODEL_NAME = "models/gemini-2.0-flash";

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

// Try to extract JSON object from messy AI text (forgiving)
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

// Deterministic fallback parser (uses goodsKeywords)
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

  // 1) Truck detection (Indian plate patterns or 6-10 alnum token)
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

  // 2) from/to detection: "A to B", "A -> B"
  for (const ln of lines) {
    const m = ln.match(/(.+?)\s*(?:to|->|→|–|—|-)\s*(.+)/i);
    if (m) {
      from = capitalize(m[1].trim());
      to = capitalize(m[2].trim());
      break;
    }
  }
  // 3) weight detection
  if (!weight) {
    for (const ln of lines) {
      const pure = ln.replace(/[,\s]/g, "");
      if (/^\d{2,7}$/.test(pure) || /^\d+(\.\d+)?\s*(kg|kgs|ton|t|mt)?$/i.test(ln)) {
        weight = parseNumberLike(ln);
        break;
      }
      const m = ln.match(/([0-9]{2,7}(?:[.,][0-9]+)?)/);
      if (m) { weight = parseNumberLike(m[1]); break; }
    }
  }

  // 4) description detection: prefer goodsKeywords match
  for (const ln of lines) {
    const low = ln.toLowerCase();
    for (const kw of goodsKeywords) {
      if (low.includes(kw)) {
        description = capitalize(ln);
        break;
      }
    }
    if (description) break;
  }
  if (!description) {
    for (const ln of lines) {
      if (/^\d+$/.test(ln.replace(/\s/g, ""))) continue;
      if (ln.toLowerCase().includes('to') && ln.split(/\s+/).length > 2) continue;
      if (ln.length > 1 && ln.length < 120) { description = capitalize(ln); break; }
    }
  }

  // 5) name detection: patterns like "n - name" or "name: X"
  for (const ln of lines) {
    const m = ln.match(/\b[nN]\s*[\-.:]?\s*(.+)$/);
    if (m) { name = capitalize(m[1].trim()); break; }
    const m2 = ln.match(/\bname\b\s*[:\-]\s*(.+)$/i);
    if (m2) { name = capitalize(m2[1].trim()); break; }
  }

  // 6) special phrase truckNumber
  const lower = String(message || "").toLowerCase();
  if (!truckNumber) {
    const specials = ['new truck','new tractor','new gadi','bellgadi','bellgada','bellgade','bellgad','brllgada'];
    for (const s of specials) if (lower.includes(s)) { truckNumber = s; break; }
  }

  return {
    truckNumber: truckNumber || "",
    from: from || "",
    to: to || "",
    weight: weight || "",
    description: description || "",
    name: name || ""
  };
}

// low-level AI call (returns text)
async function aiCall(prompt) {
  try {
    const model = genAI.getGenerativeModel ? genAI.getGenerativeModel({ model: MODEL_NAME }) : null;
    if (model && typeof model.generateContent === "function") {
      const result = await model.generateContent(prompt, { temperature: 0, maxOutputTokens: 512 });
      return result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }
    if (typeof genAI.generate === "function") {
      const resp = await genAI.generate({ prompt, temperature: 0, maxOutputTokens: 512 });
      return resp?.text || "";
    }
    return "";
  } catch (e) {
    return "";
  }
}

// ----------------- Public API -----------------
async function extractDetails(message) {
  if (!message) return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };

  const primaryPrompt = `
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
"""${String(message).replace(/```/g, "")}"""

Return the extracted information strictly in the following JSON format and NOTHING ELSE (no explanations, no code fences):

{
  "truckNumber": "",
  "from": "",
  "to": "",
  "weight": "",
  "description": "",
  "name": ""
}

If any field is missing, return it as an empty string.
`;

  const strictPrompt = `
STRICT: Reply ONLY with a single JSON object and NOTHING ELSE.
Keys: "truckNumber","from","to","weight","description","name"
If missing, set to "".

Message:
"""${String(message).replace(/```/g, "")}"""
`;

  // try AI attempts first (primary -> strict -> short strict)
  const prompts = [primaryPrompt, strictPrompt, `JSON ONLY:\n${strictPrompt}`];
  let aiParsed = null;
  for (let i = 0; i < prompts.length; i++) {
    const aiText = await aiCall(prompts[i]);
    if (!aiText) continue;

    // debug help for you: log short snippet so you can paste full raw if needed
    try { console.log(`[lrExtractor] AI raw (snippet): ${String(aiText).slice(0,800)}`); } catch (e) {}

    const parsed = tryParseJsonFromText(aiText);
    if (parsed && typeof parsed === "object") {
      aiParsed = {
        truckNumber: parsed.truckNumber ? String(parsed.truckNumber).trim() : "",
        from: parsed.from ? String(parsed.from).trim() : "",
        to: parsed.to ? String(parsed.to).trim() : "",
        weight: parsed.weight ? String(parsed.weight).trim() : "",
        description: parsed.description ? String(parsed.description).trim() : "",
        name: parsed.name ? String(parsed.name).trim() : ""
      };
      break;
    }
  }

  // fallback parse if AI missing fields or no AI result
  if (aiParsed) {
    const missing = !aiParsed.truckNumber || !aiParsed.to || !aiParsed.weight || !aiParsed.description;
    if (missing) {
      const fb = fallbackParse(message);
      aiParsed.truckNumber = aiParsed.truckNumber || fb.truckNumber || "";
      aiParsed.from = aiParsed.from || fb.from || "";
      aiParsed.to = aiParsed.to || fb.to || "";
      aiParsed.weight = aiParsed.weight || fb.weight || "";
      aiParsed.description = aiParsed.description || fb.description || "";
      aiParsed.name = aiParsed.name || fb.name || "";
    }
  }

  const final = aiParsed || fallbackParse(message);

  // Normalize truck unless it's a special phrase
  if (final.truckNumber && !["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad","brllgada"].includes(final.truckNumber.toLowerCase())) {
    final.truckNumber = normalizeTruck(final.truckNumber);
  }

  // Capitalize fields
  if (final.from) final.from = capitalize(final.from);
  if (final.to) final.to = capitalize(final.to);
  if (final.description) final.description = capitalize(final.description);
  if (final.name) final.name = capitalize(final.name);

  // Weight normalization (preserve 'fix')
  if (final.weight && !/fix/i.test(final.weight)) {
    const n = parseFloat(String(final.weight).replace(/,/g, ''));
    if (!isNaN(n)) {
      if (n > 0 && n < 100) final.weight = Math.round(n * 1000).toString();
      else final.weight = Math.round(n).toString();
    } else {
      final.weight = String(final.weight).trim();
    }
  }

  return {
    truckNumber: final.truckNumber || "",
    from: final.from || "",
    to: final.to || "",
    weight: final.weight || "",
    description: final.description || "",
    name: final.name || ""
  };
}

async function isStructuredLR(message) {
  try {
    const d = await extractDetails(message);
    return Boolean(d.truckNumber && d.to && d.weight && d.description);
  } catch (e) {
    return false;
  }
}

module.exports = { extractDetails, isStructuredLR };
