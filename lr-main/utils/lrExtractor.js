// utils/lrExtractor.js
// AI-first LR extractor (uses GoogleGenerativeAI with an in-file API key as requested).
// Exports: extractDetails(message) and isStructuredLR(message)

const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- NOTE: using the literal API key you provided (per your request) ---
const API_KEY = "AIzaSyBTt-wdj0YsByntwscggZ0dDRzrc7Qmc7I";
const MODEL_NAME = "models/gemini-2.0-flash";

const genAI = new GoogleGenerativeAI(API_KEY);

// --- Helpers ---
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

/* Robust JSON extraction from potentially messy AI output.
   Tries:
   1) find first {...} and JSON.parse
   2) forgiving fixes: quote keys, remove trailing commas, replace single quotes
*/
function tryParseJsonFromText(text) {
  if (!text) return null;
  const txt = String(text).trim();
  const jmatch = txt.match(/\{[\s\S]*\}/);
  if (!jmatch) return null;
  const raw = jmatch[0];
  try {
    return JSON.parse(raw);
  } catch (e) {
    // forgiving cleanup
    try {
      let safe = raw
        // ensure keys are quoted: foo: -> "foo":
        .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
        // replace single quotes with double quotes
        .replace(/'/g, '"')
        // remove trailing commas before } or ]
        .replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(safe);
    } catch (e2) {
      return null;
    }
  }
}

async function extractDetails(message) {
  if (!message) {
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }

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
"""${String(message).replace(/```/g, "")}"""

Return the extracted information strictly in the following JSON format (exactly one JSON object, no additional commentary):

{
  "truckNumber": "",
  "from": "",
  "to": "",
  "weight": "",
  "description": "",
  "name": ""
}
`;

  try {
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);
    const aiText =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.markdown ||
      "";

    const parsed = tryParseJsonFromText(aiText);
    if (!parsed || typeof parsed !== "object") {
      // If parse failed, return empty-safe object (AI only mode per request)
      return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
    }

    // Normalize and preserve expected fields
    let extracted = {
      truckNumber: parsed.truckNumber ? String(parsed.truckNumber).trim() : "",
      from: parsed.from ? String(parsed.from).trim() : "",
      to: parsed.to ? String(parsed.to).trim() : "",
      weight: parsed.weight ? String(parsed.weight).trim() : "",
      description: parsed.description ? String(parsed.description).trim() : "",
      name: parsed.name ? String(parsed.name).trim() : "",
    };

    // If truckNumber is one of special phrases keep as-is, else normalize plate style
    if (
      extracted.truckNumber &&
      !["new truck", "new tractor", "new gadi", "bellgadi", "bellgada", "bellgade", "bellgad", "brllgada"].includes(
        extracted.truckNumber.toLowerCase()
      )
    ) {
      extracted.truckNumber = normalizeTruck(extracted.truckNumber);
    } else if (extracted.truckNumber) {
      // keep casing as original phrase (but normalize spacing)
      extracted.truckNumber = String(extracted.truckNumber).trim();
    }

    // Capitalize textual fields
    if (extracted.from) extracted.from = capitalize(extracted.from);
    if (extracted.to) extracted.to = capitalize(extracted.to);
    if (extracted.description) extracted.description = capitalize(extracted.description);
    if (extracted.name) extracted.name = capitalize(extracted.name);

    // Weight handling: preserve "fix" words otherwise normalize numeric units
    if (extracted.weight) {
      if (/fix/i.test(extracted.weight)) {
        extracted.weight = extracted.weight.trim();
      } else {
        const num = parseFloat(String(extracted.weight).replace(/,/g, ""));
        if (!isNaN(num)) {
          if (num > 0 && num < 100) extracted.weight = Math.round(num * 1000).toString();
          else extracted.weight = Math.round(num).toString();
        } else {
          // keep as-is if not numeric
          extracted.weight = extracted.weight.trim();
        }
      }
    }

    // Ensure shape
    return {
      truckNumber: extracted.truckNumber || "",
      from: extracted.from || "",
      to: extracted.to || "",
      weight: extracted.weight || "",
      description: extracted.description || "",
      name: extracted.name || "",
    };
  } catch (e) {
    // On any error, return empty shape (AI-only mode mandated)
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }
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
