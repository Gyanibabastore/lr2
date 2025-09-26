// utils/lrExtractor.js
// Improved AI-first LR extractor with robust strict-prompting, weight heuristics,
// detailed console logging, and deterministic fallback.
// Exports: extractDetails(message) and isStructuredLR(message)

const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Inline API key (kept as provided) ---
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
// get numeric tokens with small context window
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

// detect if numeric token likely part of truck plate nearby
function looksLikeTruckNumberToken(tokenRaw, fullMessage) {
  if (!tokenRaw) return false;
  const joined = fullMessage.replace(/\s+/g, "");
  // naive check: presence of common plate pattern in message
  if (joined.match(/[A-Za-z]{2}\d{1,2}[A-Za-z]{1,3}\d{1,4}/)) {
    // if this token appears immediately after letters in original message, consider truck
    if (new RegExp(`[A-Za-z]{2}\\s?\\d{1,2}\\s?[A-Za-z]{1,3}\\s?${tokenRaw}`, "i").test(fullMessage)) {
      return true;
    }
  }
  // else conservatively return false
  return false;
}

// pick best weight candidate using heuristics
function pickBestWeightCandidate(message) {
  const weightWords = ["wt","weight","kg","kgs","kilogram","kilograms","ton","tons","t","mt","quintal"];
  const tokens = numericTokensWithContext(message);
  if (!tokens.length) return "";

  // prefer tokens near weight words
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

  // tokens that include unit suffix
  const withUnit = tokens.filter(t => /kg|kgs|mt|ton|t\b/.test(t.raw.toLowerCase()))
    .filter(t => !looksLikeTruckNumberToken(t.raw, message));
  if (withUnit.length) {
    withUnit.sort((a,b) => parseFloat(b.num) - parseFloat(a.num));
    return withUnit[0].num;
  }

  // tokens > 1000 and not truck-like
  const large = tokens.filter(t => parseFloat(t.num || 0) >= 1000 && !looksLikeTruckNumberToken(t.raw, message));
  if (large.length) {
    large.sort((a,b) => parseFloat(b.num) - parseFloat(a.num));
    return large[0].num;
  }

  // fallback: largest non-truck token
  const nonTruck = tokens.filter(t => !looksLikeTruckNumberToken(t.raw, message));
  if (nonTruck.length) {
    nonTruck.sort((a,b) => parseFloat(b.num) - parseFloat(a.num));
    return nonTruck[0].num;
  }

  // last resort: largest token
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

  // 3) weight detection using heuristics
  if (!weight) {
    const joined = lines.join(" ");
    const candidate = pickBestWeightCandidate(joined);
    if (candidate) weight = parseNumberLike(candidate);
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
      if (ln.length > 1 && ln.length < 160) { description = capitalize(ln); break; }
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

// ----------------- Low-level AI call (returns text) -----------------
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
    console.error("[lrExtractor] aiCall error:", e && e.message ? e.message : e);
    return "";
  }
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

  const promptBase = buildStrictPrompt(message);

  // try AI up to 3 attempts with small nudges
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptNote = attempt === 0 ? "" : attempt === 1 ? "\nNOTE: Return JSON only, ensure keys exist." : "\nFINAL: If unsure, leave empty.";
    const prompt = promptBase + attemptNote;
    console.log(`[lrExtractor] AI attempt ${attempt+1} - sending prompt (first 200 chars):`, prompt.slice(0,200).replace(/\n/g,' '));
    const aiText = await aiCall(prompt);
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
  console.warn("[lrExtractor] AI failed to produce valid JSON after 3 attempts — running deterministic fallback.");
  const fb = fallbackParse(message);

  // Normalize truck unless special
  if (fb.truckNumber && !["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad","brllgada"].includes(fb.truckNumber.toLowerCase())) {
    fb.truckNumber = normalizeTruck(fb.truckNumber);
  }
  if (fb.from) fb.from = capitalize(fb.from);
  if (fb.to) fb.to = capitalize(fb.to);
  if (fb.description) fb.description = capitalize(fb.description);
  if (fb.name) fb.name = capitalize(fb.name);

  // Weight normalization (preserve 'fix')
  if (fb.weight && !/fix/i.test(fb.weight)) {
    const wn2 = String(fb.weight).replace(/,/g,"");
    const n2 = parseFloat(wn2);
    if (!isNaN(n2)) {
      if (n2 > 0 && n2 < 100) fb.weight = Math.round(n2 * 1000).toString();
      else fb.weight = Math.round(n2).toString();
    } else {
      fb.weight = fb.weight;
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
