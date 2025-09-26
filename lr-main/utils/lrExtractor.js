

const API_KEY = "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"; // 

const PREFERRED_MODELS = [
  "gpt-5-nano",
  "gpt-5-mini",
  "gpt-5-small"
];

let SELECTED_MODEL = PREFERRED_MODELS[0];
let rateLimitResetTs = 0;

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

// try extract JSON object from messy AI text
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
      const safe = raw
        .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
        .replace(/'/g, '"')
        .replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(safe);
    } catch (e2) {
      console.error("[lrExtractor] JSON parse failed twice:", e2.message);
      return null;
    }
  }
}

// ----------------- Build the prompt -----------------
function buildStrictPrompt(message) {
  return `
You are a precise logistics parser. Extract ONLY a single JSON object.

Mandatory fields: truckNumber, to, weight, description
Optional: from, name

Rules:
- Normalize truckNumber like MH09HH4512 (remove spaces/dots/hyphens).
- If no plate, but words like "brllgada", "bellgadi", "new truck" etc. exist, set truckNumber to that word.
- Preserve "fix" in weight.
- If a field not found, use "".

Schema:
{
  "truckNumber": "",
  "from": "",
  "to": "",
  "weight": "",
  "description": "",
  "name": ""
}

Message:
"""${String(message).replace(/```/g, "")}"""
`;
}

// ----------------- AI Call -----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function aiCallWithRateLimit(prompt) {
  if (Date.now() < rateLimitResetTs) {
    console.warn("[lrExtractor] Skipping AI call until:", new Date(rateLimitResetTs));
    return "";
  }

  try {
    console.log("[lrExtractor] Sending request to OpenAI Responses API with model:", SELECTED_MODEL);

    const body = {
      model: SELECTED_MODEL,
      input: prompt,
      temperature: 0,
      max_output_tokens: 600
    };

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify(body)
    });

    if (resp.status === 429 || resp.status === 503) {
      const ra = resp.headers.get("retry-after");
      const waitSec = ra ? parseInt(ra, 10) : 5;
      rateLimitResetTs = Date.now() + (waitSec + 1) * 1000;
      console.warn(`[lrExtractor] Rate limit hit. Backing off for ${waitSec}s.`);
      return "";
    }

    if (!resp.ok) {
      const text = await resp.text();
      console.error("[lrExtractor] OpenAI API error:", resp.status, text.slice(0, 300));
      return "";
    }

    const data = await resp.json();
    let outText = "";

    if (Array.isArray(data.output)) {
      for (const o of data.output) {
        if (o.type === "output_text" && o.text) outText += o.text + "\n";
        if (o.type === "message" && Array.isArray(o.content)) {
          for (const c of o.content) if (c.type === "output_text" && c.text) outText += c.text;
        }
      }
    } else if (data?.output_text) outText = data.output_text;
    else if (data?.text) outText = data.text;

    console.log("[lrExtractor] AI raw text length:", outText.length);
    return outText.trim();
  } catch (err) {
    console.error("[lrExtractor] aiCall error:", err.message || err);
    return "";
  }
}

// ----------------- Public API -----------------
async function extractDetails(message) {
  console.log("\n================ NEW EXTRACTION START ================");
  const startTs = Date.now();

  if (!message) {
    console.warn("[lrExtractor] Empty message received.");
    return null;
  }

  const prompt = buildStrictPrompt(message);

  for (let attempt = 0; attempt < 3; attempt++) {
    const suffix = attempt === 0 ? "" : attempt === 1 ? "\nNOTE: JSON only!" : "\nFINAL ATTEMPT: Ensure keys exist.";
    const fullPrompt = prompt + suffix;

    console.log(`[lrExtractor] Attempt ${attempt + 1} - prompt size:`, fullPrompt.length);

    const aiText = await aiCallWithRateLimit(fullPrompt);
    if (!aiText) {
      console.warn(`[lrExtractor] Attempt ${attempt + 1} returned empty.`);
      continue;
    }

    console.log(`[lrExtractor] Attempt ${attempt + 1} raw response:`, aiText.slice(0, 500));

    const parsed = tryParseJsonFromText(aiText);
    if (!parsed) {
      console.warn(`[lrExtractor] Attempt ${attempt + 1} -> JSON parse failed.`);
      continue;
    }

    console.log("[lrExtractor] Parsed JSON:", parsed);

    const out = {
      truckNumber: parsed.truckNumber ? String(parsed.truckNumber).trim() : "",
      from: parsed.from ? String(parsed.from).trim() : "",
      to: parsed.to ? String(parsed.to).trim() : "",
      weight: parsed.weight ? String(parsed.weight).trim() : "",
      description: parsed.description ? String(parsed.description).trim() : "",
      name: parsed.name ? String(parsed.name).trim() : ""
    };

    // normalize
    const specials = ["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad","brllgada"];
    if (out.truckNumber && !specials.includes(out.truckNumber.toLowerCase())) {
      out.truckNumber = normalizeTruck(out.truckNumber);
    }
    if (out.from) out.from = capitalize(out.from);
    if (out.to) out.to = capitalize(out.to);
    if (out.description) out.description = capitalize(out.description);
    if (out.name) out.name = capitalize(out.name);

    // normalize weight
    if (out.weight && !/fix/i.test(out.weight)) {
      const n = parseFloat(out.weight.replace(/,/g, ""));
      if (!isNaN(n)) {
        out.weight = n < 100 ? Math.round(n * 1000).toString() : Math.round(n).toString();
      }
    }

    const mandatoryPresent = out.truckNumber && out.to && out.weight && out.description;
    if (mandatoryPresent) {
      console.log("[lrExtractor] SUCCESS ✅ Took(ms):", Date.now() - startTs, "Final:", out);
      console.log("=====================================================\n");
      return out;
    } else {
      console.warn("[lrExtractor] Attempt failed (missing mandatory fields).", out);
    }

    await sleep(400 * (attempt + 1));
  }

  console.error("[lrExtractor] ❌ All attempts failed. Returning null.");
  console.log("=====================================================\n");
  return null;
}

async function isStructuredLR(message) {
  const d = await extractDetails(message);
  return Boolean(d && d.truckNumber && d.to && d.weight && d.description);
}

module.exports = { extractDetails, isStructuredLR };
