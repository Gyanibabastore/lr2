// utils/lrExtractor.js
// AI-first extractor with local regex fallback + tolerant isStructuredLR
// Preserves original AI prompt behavior and post-processing

const { GoogleGenerativeAI } = require("@google/generative-ai");

// If you already initialize genAI elsewhere, you can keep that.
// Here we use same pattern as your original snippet.
const API_KEY = process.env.GENAI_API_KEY || process.env.GOOGLE_GEN_AI_KEY || "AIzaSyBTt-wdj0YsByntwscggZ0dDRzrc7Qmc7I";
const MODEL_NAME = process.env.GENAI_MODEL || "models/gemini-2.0-flash";

let genAI = null;
try {
  genAI = new GoogleGenerativeAI(API_KEY);
} catch (e) {
  genAI = null;
  // console.warn("genAI init failed, falling back to local parser");
}

// -------------------- Helpers --------------------
function normalizeLines(msg) {
  if (!msg || typeof msg !== "string") return [];
  return msg.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function findTruckNumber(msg) {
  if (!msg) return null;
  const truckRegexes = [
    /([A-Z]{2}\s*\d{1,2}\s*[A-Z]{1,3}\s*\d{3,5})/i,   // MH 09 AB 1234 or similar
    /([A-Z]{2}\s*\d{1,2}\s*\d{3,5})/i,                // AB09 1234 fallback
    /\b([A-Z]{2}\d{2}[A-Z]{0,3}\d{3,5})\b/i           // contiguous like MP09AB9811
  ];
  for (const r of truckRegexes) {
    const m = msg.match(r);
    if (m && m[1]) return String(m[1]).replace(/\s+/g, "").toUpperCase();
  }
  return null;
}

function findWeight(msg) {
  if (!msg) return null;
  // preserve 'fix' if present near number
  const mFix = msg.match(/\b(\d{1,6}\s*(?:fix|FIX|Fix)?)\b/);
  if (mFix && /fix/i.test(mFix[0])) return mFix[0].trim();
  const m = msg.match(/\b(\d{3,6})\b/); // weights like 2511
  if (m) return m[1];
  return null;
}

function findFromTo(msg) {
  if (!msg) return {};
  const s = msg.replace(/\r?\n/g, " ");
  const fromToRegex = /([A-Za-z\u00C0-\u017F0-9 .-]{2,30})\s+(?:to|-)\s+([A-Za-z\u00C0-\u017F0-9 .-]{2,30})/i;
  const m = s.match(fromToRegex);
  if (m) return { from: m[1].trim(), to: m[2].trim() };
  return {};
}

function capitalize(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Local (regex) extractor fallback
async function localExtract(message) {
  const s = String(message || "");
  const lines = normalizeLines(s);
  const joined = lines.join(" | ");

  const truckNumber = findTruckNumber(joined) || "";
  const weight = findWeight(joined) || "";
  const ft = findFromTo(joined);
  const from = ft.from || "";
  const to = ft.to || "";

  // description: everything except truck and weight tokens removed for cleanliness
  let description = joined;
  if (truckNumber) description = description.replace(new RegExp(truckNumber, "ig"), "");
  if (weight) description = description.replace(new RegExp(String(weight), "ig"), "");
  description = description.replace(/\s{2,}/g, " ").trim();

  // name heuristic: look for n.name patterns or last short non-numeric line
  let name = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(/(?:^|\s)(?:n[\.\-\s]?|name[\s:\-]?)([A-Za-z .]{2,50})$/i);
    if (m && m[1]) { name = m[1].trim(); break; }
    if (!/^\d+$/.test(line.trim()) && line.trim().length <= 30 && /[A-Za-z]/.test(line)) {
      name = line.trim();
      break;
    }
  }

  const out = {
    truckNumber: truckNumber || "",
    from: from || "",
    to: to || "",
    weight: weight || "",
    description: description || joined || "",
    name: name || ""
  };

  // post-process capitalization & weight normalization (same logic as original)
  if (out.from) out.from = capitalize(out.from);
  if (out.to) out.to = capitalize(out.to);
  if (out.description) out.description = capitalize(out.description);
  if (out.name) out.name = capitalize(out.name);

  if (out.weight) {
    if (/fix/i.test(out.weight)) {
      out.weight = out.weight.trim();
    } else {
      const weightNum = parseFloat(out.weight);
      if (!isNaN(weightNum)) {
        if (weightNum > 0 && weightNum < 100) out.weight = Math.round(weightNum * 1000).toString();
        else out.weight = Math.round(weightNum).toString();
      }
    }
  }

  return out;
}

// -------------------- Main extractDetails (AI first, fallback local) --------------------
async function extractDetails(message) {
  // AI-first approach (preserve original prompt behavior)
  if (genAI) {
    try {
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
  "truckNumber": "",    // mandatory
  "from": "",           // optional
  "to": "",             // mandatory
  "weight": "",         // mandatory
  "description": "",    // mandatory
  "name": ""            // optional
}

If any field is missing, return it as an empty string.

Ensure the output is only the raw JSON — no extra text, notes, or formatting outside the JSON structure.
      `;

      const model = genAI.getGenerativeModel({ model: MODEL_NAME });
      const result = await model.generateContent(prompt);
      let resultText = result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      resultText = resultText.trim();
      resultText = resultText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();

      let extracted = {};
      try {
        extracted = JSON.parse(resultText);
      } catch (e) {
        // If parse fails, fallback to local extraction
        return await localExtract(message);
      }

      // If truckNumber not present, check message keywords
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

      if (
        extracted.truckNumber &&
        !["new truck", "new tractor", "new gadi", "bellgadi", "bellgada", "bellgade", "bellgad"].includes(
          String(extracted.truckNumber).toLowerCase()
        )
      ) {
        extracted.truckNumber = String(extracted.truckNumber).replace(/[\s.-]/g, "").toUpperCase();
      }

      // capitalization & weight logic (same as original)
      if (extracted.from) extracted.from = capitalize(extracted.from);
      if (extracted.to) extracted.to = capitalize(extracted.to);
      if (extracted.description) extracted.description = capitalize(extracted.description);
      if (extracted.name) extracted.name = capitalize(extracted.name);

      if (extracted.weight) {
        if (/fix/i.test(extracted.weight)) {
          extracted.weight = extracted.weight.trim();
        } else {
          const weightNum = parseFloat(extracted.weight);
          if (!isNaN(weightNum)) {
            if (weightNum > 0 && weightNum < 100) extracted.weight = Math.round(weightNum * 1000).toString();
            else extracted.weight = Math.round(weightNum).toString();
          }
        }
      }

      return {
        truckNumber: extracted.truckNumber || "",
        from: extracted.from || "",
        to: extracted.to || "",
        weight: extracted.weight || "",
        description: extracted.description || "",
        name: extracted.name || ""
      };
    } catch (e) {
      // any genAI runtime error -> fallback to local
      return await localExtract(message);
    }
  }

  // No genAI available -> local extraction
  return await localExtract(message);
}

// -------------------- isStructuredLR (tolerant) --------------------
async function isStructuredLR(message) {
  const d = await extractDetails(message);

  const hasTruck = !!(d.truckNumber && String(d.truckNumber).trim().length > 0);
  const hasTo = !!(d.to && String(d.to).trim().length > 0);
  const hasWeight = !!(d.weight && String(d.weight).trim().length > 0);
  const descLines = (d.description || "").split(/\r?\n|\|/).map(s => s.trim()).filter(Boolean).length;

  // tolerate if truck present and at least one of (to | weight | multi-line desc)
  const plausible = hasTruck && (hasTo || hasWeight || descLines >= 2);

  return !!plausible;
}

module.exports = { extractDetails, isStructuredLR };
