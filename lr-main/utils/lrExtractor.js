// utils/lrExtractor.js
// AI-first LR extractor (uses GoogleGenerativeAI with an in-file API key).
// Exports: extractDetails(message) and isStructuredLR(message)

const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Inline API key as requested ---
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

// Try to extract a JSON object from messy text and parse it (forgiving fixes)
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
        .replace(/'/g, '"') // single -> double quotes
        .replace(/,(\s*[}\]])/g, "$1"); // remove trailing commas
      return JSON.parse(safe);
    } catch (e2) {
      return null;
    }
  }
}

// Low-level call to the AI model (returns text)
async function aiCall(prompt, opts = {}) {
  try {
    const model = genAI.getGenerativeModel ? genAI.getGenerativeModel({ model: MODEL_NAME }) : null;
    if (model && typeof model.generateContent === "function") {
      const result = await model.generateContent(prompt, { temperature: 0, maxOutputTokens: 512, ...opts });
      return result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }
    if (typeof genAI.generate === "function") {
      const resp = await genAI.generate({ prompt, temperature: 0, maxOutputTokens: 512, ...opts });
      return resp?.text || "";
    }
    return "";
  } catch (e) {
    return "";
  }
}

async function extractDetails(message) {
  if (!message) {
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }

  // Primary prompt (explicit, includes example)
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

If truckNumber is missing, but the message contains words like "brllgada","bellgade","bellgad","bellgadi","new truck", "new tractor", or "new gadi", then set truckNumber to that phrase (exactly as it appears).

If the weight contains the word "fix" or similar, preserve it as-is.

Here is the message:
"""${String(message).replace(/```/g, "")}"""

Return the extracted information strictly in the following JSON format (ONLY the JSON object — no explanations, no bullet points, no extra text):

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

  // Strict fallback prompt (even more forceful)
  const strictPrompt = `
STRICT: Reply ONLY with a single JSON object (no code fences, no commentary).
Keys: "truckNumber","from","to","weight","description","name"
If a field not found, set it to "".

Message:
"""${String(message).replace(/```/g, "")}"""
`;

  // Try attempts (primary -> strict). Parse forgivingly.
  const attempts = [primaryPrompt, strictPrompt];
  for (let i = 0; i < attempts.length; i++) {
    const aiText = await aiCall(attempts[i]);
    if (!aiText) continue;
    const parsed = tryParseJsonFromText(aiText);
    if (!parsed || typeof parsed !== "object") continue;

    // Build normalized output
    let extracted = {
      truckNumber: parsed.truckNumber ? String(parsed.truckNumber).trim() : "",
      from: parsed.from ? String(parsed.from).trim() : "",
      to: parsed.to ? String(parsed.to).trim() : "",
      weight: parsed.weight ? String(parsed.weight).trim() : "",
      description: parsed.description ? String(parsed.description).trim() : "",
      name: parsed.name ? String(parsed.name).trim() : "",
    };

    // Normalize truck plate unless it's a special phrase
    if (
      extracted.truckNumber &&
      !["new truck", "new tractor", "new gadi", "bellgadi", "bellgada", "bellgade", "bellgad", "brllgada"].includes(
        extracted.truckNumber.toLowerCase()
      )
    ) {
      extracted.truckNumber = normalizeTruck(extracted.truckNumber);
    } else if (extracted.truckNumber) {
      extracted.truckNumber = String(extracted.truckNumber).trim();
    }

    // Capitalize words
    if (extracted.from) extracted.from = capitalize(extracted.from);
    if (extracted.to) extracted.to = capitalize(extracted.to);
    if (extracted.description) extracted.description = capitalize(extracted.description);
    if (extracted.name) extracted.name = capitalize(extracted.name);

    // Weight handling: preserve 'fix' else normalize numeric
    if (extracted.weight) {
      if (/fix/i.test(extracted.weight)) {
        extracted.weight = extracted.weight.trim();
      } else {
        const n = parseFloat(String(extracted.weight).replace(/,/g, ""));
        if (!isNaN(n)) {
          if (n > 0 && n < 100) extracted.weight = Math.round(n * 1000).toString();
          else extracted.weight = Math.round(n).toString();
        } else {
          extracted.weight = extracted.weight.trim();
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
  }

  // If AI fails both attempts, return empty shape (AI-only policy)
  return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
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
