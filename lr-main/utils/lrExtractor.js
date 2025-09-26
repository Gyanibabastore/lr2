// utils/lrExtractor.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Use environment variable for key; do NOT hardcode API keys in code
const API_KEY = process.env.GENAI_API_KEY || "";
const MODEL_NAME = process.env.GENAI_MODEL || "models/gemini-2.0-flash";

let genAI = null;
if (API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(API_KEY);
  } catch (e) {
    console.warn("⚠️ genAI init failed:", e?.message || e);
    genAI = null;
  }
}

// Helper simple normalizers & local fallback extraction (keeps logic tight)
function capitalize(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function simpleClean(s) {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

function findTruckNumber(msg) {
  if (!msg) return "";
  // attempt several patterns
  const patterns = [
    /([A-Z]{2}\s*\d{1,2}\s*[A-Z]{1,3}\s*\d{3,5})/i,
    /([A-Z]{2}\d{2}[A-Z]{0,3}\d{3,5})/i,
    /\b([A-Z]{2}\s*\d{1,2}\s*\d{3,5})\b/i
  ];
  for (const p of patterns) {
    const m = msg.match(p);
    if (m && m[1]) return m[1].replace(/[\s.-]/g, "").toUpperCase();
  }
  return "";
}

function findWeight(msg) {
  if (!msg) return "";
  const mFix = msg.match(/\b(\d{1,6}\s*(?:fix|FIX|Fix)?)\b/);
  if (mFix && /fix/i.test(mFix[0])) return mFix[0].trim();
  const m = msg.match(/\b(\d{3,6})\b/);
  if (m) return m[1];
  return "";
}

function findFromTo(msg) {
  if (!msg) return { from: "", to: "" };
  const cleaned = msg.replace(/\r?\n/g, " ");
  const m = cleaned.match(/([A-Za-z0-9 .-]{2,30})\s+(?:to|-)\s+([A-Za-z0-9 .-]{2,30})/i);
  if (m) return { from: simpleClean(m[1]), to: simpleClean(m[2]) };
  return { from: "", to: "" };
}

// Local fallback extractor
async function localExtract(message) {
  const s = String(message || "");
  const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const joined = lines.join(" | ");

  // name detection (n. or last short line)
  let name = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/(?:^|\s)(?:n[\.\-\s]?|name[\s:\-]?)([A-Za-z .]{2,50})$/i);
    if (m && m[1]) { name = m[1].trim(); break; }
    if (!/^\d+$/.test(line) && line.length <= 30 && /[A-Za-z]/.test(line)) {
      const low = line.toLowerCase();
      if (!/(to|scrap|weight|kg|mobile|truck)/i.test(low)) { name = line.trim(); break; }
    }
  }

  const truckNumber = findTruckNumber(joined) || "";
  const weight = findWeight(joined) || "";
  const ft = findFromTo(joined);
  const descriptionRaw = joined;

  // Clean description: remove truck/weight/name tokens
  let desc = descriptionRaw;
  if (truckNumber) desc = desc.replace(new RegExp(truckNumber, "ig"), "");
  if (weight) desc = desc.replace(new RegExp(weight, "ig"), "");
  if (name) desc = desc.replace(new RegExp(name, "ig"), "");
  desc = desc.replace(/\s*\|\s*/g, " | ").replace(/\|{2,}/g, "|").replace(/\s{2,}/g, " ").trim();
  desc = desc.replace(/^\|+|\|+$/g, "").trim().split("|").map(p => capitalize(p.trim())).filter(Boolean).join(" | ");

  let out = {
    truckNumber: truckNumber || "",
    from: ft.from ? capitalize(ft.from) : "",
    to: ft.to ? capitalize(ft.to) : "",
    weight: weight || "",
    description: desc || "",
    name: name ? capitalize(name) : ""
  };

  // weight normalization
  if (out.weight) {
    if (/fix/i.test(out.weight)) out.weight = out.weight.trim();
    else {
      const wn = parseFloat(out.weight);
      if (!isNaN(wn)) {
        out.weight = (wn > 0 && wn < 100) ? Math.round(wn * 1000).toString() : Math.round(wn).toString();
      }
    }
  }

  return out;
}

// Main extractor (Gemini-first, then fallback)
async function extractDetails(message) {
  const prompt = `
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
"${String(message).replace(/"/g, '\\"')}"

Return the extracted information strictly in the following JSON format:

{
  "truckNumber": "",
  "from": "",
  "to": "",
  "weight": "",
  "description": "",
  "name": ""
}

If any field is missing, return it as an empty string.
Return only the raw JSON.
`;

  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: MODEL_NAME });
      const result = await model.generateContent(prompt);
      let resultText = result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      resultText = resultText.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();

      let extracted = {};
      try {
        extracted = JSON.parse(resultText);
      } catch (e) {
        return await localExtract(message);
      }

      // fallback heuristics for truck name words
      if (!extracted.truckNumber) {
        const lowerMsg = String(message).toLowerCase();
        if (lowerMsg.includes("new truck")) extracted.truckNumber = "new truck";
        else if (lowerMsg.includes("new tractor")) extracted.truckNumber = "new tractor";
        else if (lowerMsg.includes("new gadi")) extracted.truckNumber = "new gadi";
        else if (lowerMsg.includes("bellgadi")) extracted.truckNumber = "bellgadi";
        else if (lowerMsg.includes("bellgada")) extracted.truckNumber = "bellgada";
        else if (lowerMsg.includes("bellgade")) extracted.truckNumber = "bellgade";
        else if (lowerMsg.includes("bellgad")) extracted.truckNumber = "bellgad";
      }

      if (extracted.truckNumber && !["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad"].includes(String(extracted.truckNumber).toLowerCase())) {
        extracted.truckNumber = String(extracted.truckNumber).replace(/[\s.-]/g, "").toUpperCase();
      }

      extracted.description = (extracted.description || "").toString();
      let desc = extracted.description.replace(/\s*\|\s*/g, " | ").trim();
      desc = desc.replace(/^\|+|\|+$/g, "").trim();
      desc = desc.split("|").map(p => capitalize(p.trim())).filter(Boolean).join(" | ");

      const out = {
        truckNumber: extracted.truckNumber || "",
        from: extracted.from ? capitalize(extracted.from) : "",
        to: extracted.to ? capitalize(extracted.to) : "",
        weight: extracted.weight || "",
        description: desc || "",
        name: extracted.name ? capitalize(extracted.name) : ""
      };

      if (out.weight) {
        if (/fix/i.test(out.weight)) out.weight = out.weight.trim();
        else {
          const wn = parseFloat(out.weight);
          if (!isNaN(wn)) out.weight = (wn > 0 && wn < 100) ? Math.round(wn * 1000).toString() : Math.round(wn).toString();
        }
      }

      return out;
    } catch (e) {
      return await localExtract(message);
    }
  }

  // No genAI configured -> fallback
  return await localExtract(message);
}

// Strict LR check: require all four mandatory fields non-empty
async function isStructuredLR(message) {
  const d = await extractDetails(message);
  return !!(d && d.truckNumber && d.to && d.weight && d.description);
}

module.exports = { extractDetails, isStructuredLR };
