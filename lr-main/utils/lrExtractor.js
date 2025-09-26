
const API_KEY = "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";

const SELECTED_MODEL = "gpt-5-nano";
let rateLimitResetTs = 0;

// For reproducible empty return
const EMPTY_OUT = { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };

if (!API_KEY || API_KEY === "sk-REPLACE_WITH_OPENAI_KEY") {
  console.warn("[lrExtractor] WARNING: OPENAI API key not set (or left placeholder). Paste your key into API_KEY to enable AI calls.");
}

// ----------------- Helpers -----------------
const normalizeTruck = (s) => {
  if (!s) return "";
  const normalized = String(s).replace(/[\s\.-]/g, "").toUpperCase();
  console.debug && console.debug("[lrExtractor] normalizeTruck:", s, "->", normalized);
  return normalized;
};
const capitalize = (str) => {
  if (!str) return "";
  const cap = String(str)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
    .join(" ");
  console.debug && console.debug("[lrExtractor] capitalize:", str, "->", cap);
  return cap;
};
const parseNumberLike = (t) => {
  if (!t) return "";
  const cleaned = String(t).replace(/,/g, "").trim();
  const m = cleaned.match(/(\d+(?:\.\d+)?)/);
  const val = m ? m[1] : "";
  console.debug && console.debug("[lrExtractor] parseNumberLike:", t, "->", val);
  return val;
};

// try extract JSON object from messy AI text
function tryParseJsonFromText(text) {
  console.debug && console.debug("[lrExtractor] tryParseJsonFromText input length:", text ? String(text).length : 0);
  if (!text) return null;
  const txt = String(text).trim();
  const jmatch = txt.match(/\{[\s\S]*\}/);
  if (!jmatch) {
    console.debug && console.debug("[lrExtractor] no {...} JSON block found in AI output.");
    return null;
  }
  const raw = jmatch[0];
  console.debug && console.debug("[lrExtractor] tryParseJsonFromText raw JSON snippet:", raw.slice(0, 600));
  try {
    const parsed = JSON.parse(raw);
    console.debug && console.debug("[lrExtractor] JSON.parse succeeded.");
    return parsed;
  } catch (e) {
    console.warn("[lrExtractor] JSON.parse failed, attempting safe-fix parse. Error:", e && e.message ? e.message : e);
    try {
      const safe = raw
        .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":') // quote keys
        .replace(/'/g, '"') // single -> double quotes
        .replace(/,(\s*[}\]])/g, "$1"); // remove trailing commas
      const parsed2 = JSON.parse(safe);
      console.debug && console.debug("[lrExtractor] Safe JSON.parse succeeded after fixes.");
      return parsed2;
    } catch (e2) {
      console.error("[lrExtractor] Safe JSON parse failed:", e2 && e2.message ? e2.message : e2);
      return null;
    }
  }
}

// ----------------- Low-level AI call with rate-limit respect (OpenAI Responses API) -----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function aiCallWithRateLimit(prompt) {
  if (Date.now() < rateLimitResetTs) {
    console.warn("[lrExtractor] Skipping AI call due to prior rate-limit until", new Date(rateLimitResetTs));
    return "";
  }

  if (!API_KEY || API_KEY === "sk-REPLACE_WITH_OPENAI_KEY") {
    console.warn("[lrExtractor] No valid OPENAI API key present — skipping AI call.");
    return "";
  }

  try {
    console.log("[lrExtractor] Sending request to OpenAI Responses API with model:", SELECTED_MODEL);
    console.debug && console.debug("[lrExtractor] Prompt (first500):", String(prompt).slice(0, 500));

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

    console.debug && console.debug("[lrExtractor] OpenAI HTTP status:", resp.status);

    // explicit auth failure handling
    if (resp.status === 401) {
      const txt = await resp.text().catch(() => "");
      console.error("[lrExtractor] AUTH ERROR 401 — invalid OpenAI API key. Response snippet:", String(txt).slice(0,300));
      rateLimitResetTs = Date.now() + 10 * 1000;
      return "";
    }

    if (resp.status === 429 || resp.status === 503) {
      const ra = resp.headers.get("retry-after");
      const waitSec = ra ? parseInt(ra, 10) : 5;
      rateLimitResetTs = Date.now() + (waitSec + 1) * 1000;
      console.warn(`[lrExtractor] Rate limit hit (status ${resp.status}). Backing off for ${waitSec}s.`);
      return "";
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("[lrExtractor] OpenAI Responses API error:", resp.status, text.slice(0, 300));
      return "";
    }

    const data = await resp.json();
    console.debug && console.debug("[lrExtractor] OpenAI response JSON keys:", Object.keys(data || {}));

    let outText = "";

    if (Array.isArray(data.output)) {
      for (const o of data.output) {
        if (o.type === "output_text" && o.text) {
          outText += o.text + "\n";
          console.debug && console.debug("[lrExtractor] collected output_text chunk length:", String(o.text).length);
        }
        if (o.type === "message" && Array.isArray(o.content)) {
          for (const c of o.content) {
            if (c.type === "output_text" && c.text) {
              outText += c.text;
              console.debug && console.debug("[lrExtractor] collected message.content output_text chunk length:", String(c.text).length);
            }
            if (c.type === "output_text" && c.text === undefined && c.parts) {
              outText += (c.parts.join("\n") || "");
              console.debug && console.debug("[lrExtractor] collected message.content.parts combined length:", String((c.parts || []).join("")).length);
            }
          }
        }
      }
    } else if (data?.output_text) {
      outText = data.output_text;
      console.debug && console.debug("[lrExtractor] data.output_text used.");
    } else if (data?.text) {
      outText = data.text;
      console.debug && console.debug("[lrExtractor] data.text used.");
    } else if (data?.choices && Array.isArray(data.choices)) {
      for (const ch of data.choices) {
        if (ch.text) outText += ch.text;
        if (ch.message && ch.message.content) outText += (ch.message.content?.map?.(p => p.text).join?.("") || "");
      }
      console.debug && console.debug("[lrExtractor] fallback choices parsed.");
    }

    console.log("[lrExtractor] AI raw text length:", outText.length);
    console.debug && console.debug("[lrExtractor] AI text snippet (1k):", String(outText).slice(0, 1000));
    return outText.trim();
  } catch (err) {
    const msg = err && (err.message || String(err));
    console.error("[lrExtractor] aiCall error:", msg);

    // try to extract retry seconds from message
    let retrySec = null;
    try {
      const rm = msg && (msg.match && (msg.match(/retry-after[:= ]?([0-9]+)/i) || msg.match(/Please retry in\s*([0-9.]+)s/i)));
      if (rm) {
        retrySec = parseInt(rm[1], 10);
      }
    } catch (e) {
      // ignore
    }
    if (!isNaN(retrySec) && retrySec !== null) {
      rateLimitResetTs = Date.now() + (retrySec + 1) * 1000;
      console.warn(`[lrExtractor] API requested retry-after -> skipping AI until ${new Date(rateLimitResetTs)}`);
    }

    return "";
  }
}

// ----------------- Hardened prompt builder -----------------
function buildStrictPrompt(message) {
  const sanitized = String(message).replace(/```/g, "");
  const p = `
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
"""${sanitized}"""

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
  console.debug && console.debug("[lrExtractor] buildStrictPrompt length:", p.length);
  return p;
}

// ----------------- Public API (OpenAI-based extraction) -----------------
async function extractDetails(message) {
  const startTs = Date.now();
  console.log("[lrExtractor] extractDetails called. Message snippet:", String(message || "").slice(0,300).replace(/\n/g, ' | '));

  if (!message) {
    console.log("[lrExtractor] Empty message -> returning empty object.");
    return { ...EMPTY_OUT };
  }

  const prompt = buildStrictPrompt(message);

  // Always use AI (3 attempts)
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptNote = attempt === 0 ? "" : attempt === 1 ? "\nNOTE: Return JSON only, ensure keys exist." : "\nFINAL: If unsure, leave empty.";
    const fullPrompt = prompt + attemptNote;
    console.log(`[lrExtractor] AI attempt ${attempt+1} - sending prompt (chars):`, fullPrompt.length);

    const aiText = await aiCallWithRateLimit(fullPrompt);
    if (!aiText) {
      console.warn(`[lrExtractor] AI attempt ${attempt+1} returned empty response. (attemptNote: "${attemptNote.trim()}")`);
      await sleep(200 * (attempt + 1)); // small backoff
      continue;
    }

    console.log(`[lrExtractor] AI raw response received (length ${aiText.length}). Attempt ${attempt+1}.`);
    console.debug && console.debug(`[lrExtractor] AI response snippet (1k):\n${String(aiText).slice(0,1200)}`);

    const parsed = tryParseJsonFromText(aiText);
    if (parsed && typeof parsed === "object") {
      console.log(`[lrExtractor] AI parsed JSON (raw object):`, parsed);

      // sanitize & normalize
      const out = {
        truckNumber: parsed.truckNumber ? String(parsed.truckNumber).trim() : "",
        from: parsed.from ? String(parsed.from).trim() : "",
        to: parsed.to ? String(parsed.to).trim() : "",
        weight: parsed.weight ? String(parsed.weight).trim() : "",
        description: parsed.description ? String(parsed.description).trim() : "",
        name: parsed.name ? String(parsed.name).trim() : ""
      };

      console.debug && console.debug("[lrExtractor] After initial sanitization:", out);

      // ----------- ONLY FIX: if AI omitted 'from', try "A to B" extraction from original message -----------
      if ((!out.from || out.from.trim() === "") && message) {
        const m = String(message).match(/(.+?)\s*(?:to|->|→|–|—|-)\s*(.+)/i);
        if (m) {
          const candidateFrom = m[1].trim();
          const isPlate = /^[A-Za-z]{2}\s?\d{1,2}\s?[A-Za-z]{1,3}\s?\d{1,4}$/i.test(candidateFrom);
          const isNumber = /^\d+(\.\d+)?$/.test(candidateFrom.replace(/\s+/g,''));
          if (!isPlate && !isNumber) {
            out.from = candidateFrom;
            console.debug && console.debug("[lrExtractor] from inferred from 'A to B' pattern:", out.from);
          } else {
            console.debug && console.debug("[lrExtractor] 'from' candidate rejected as plate/number:", candidateFrom);
          }
        } else {
          console.debug && console.debug("[lrExtractor] No 'A to B' pattern found for 'from' inference.");
        }
      }
      // -----------------------------------------------------------------------------------------------

      // normalize truck unless it's a special phrase
      const specials = ["new truck","new tractor","new gadi","bellgadi","bellgada","bellgade","bellgad","brllgada"];
      if (out.truckNumber && !specials.includes(out.truckNumber.toLowerCase())) {
        const before = out.truckNumber;
        out.truckNumber = normalizeTruck(out.truckNumber);
        console.debug && console.debug("[lrExtractor] truckNumber normalized:", before, "->", out.truckNumber);
      } else if (out.truckNumber) {
        console.debug && console.debug("[lrExtractor] truckNumber left as special phrase:", out.truckNumber);
      }

      if (out.from) out.from = capitalize(out.from);
      if (out.to) out.to = capitalize(out.to);
      if (out.description) out.description = capitalize(out.description);
      if (out.name) out.name = capitalize(out.name);

      console.debug && console.debug("[lrExtractor] After capitalization:", {
        truckNumber: out.truckNumber,
        from: out.from,
        to: out.to,
        description: out.description,
        name: out.name
      });

      // weight normalization (preserve 'fix')
      if (out.weight && !/fix/i.test(out.weight)) {
        const wn = String(out.weight).replace(/,/g,"");
        const n = parseFloat(wn);
        if (!isNaN(n)) {
          const beforeW = out.weight;
          if (n > 0 && n < 100) out.weight = Math.round(n * 1000).toString();
          else out.weight = Math.round(n).toString();
          console.debug && console.debug("[lrExtractor] weight normalized:", beforeW, "->", out.weight);
        } else {
          console.debug && console.debug("[lrExtractor] weight parseFloat produced NaN — left as-is:", out.weight);
        }
      } else if (out.weight) {
        console.debug && console.debug("[lrExtractor] weight contains 'fix' — preserving as-is:", out.weight);
      }

      const mandatoryPresent = out.truckNumber && out.to && out.weight && out.description;
      console.debug && console.debug("[lrExtractor] mandatoryPresent check:", mandatoryPresent);

      if (mandatoryPresent) {
        console.log("[lrExtractor] SUCCESS ✅ Took(ms):", Date.now() - startTs, "Final:", out);
        return out;
      } else {
        console.warn("[lrExtractor] Attempt failed (missing mandatory fields). Current out:", out);
      }
    } else {
      console.warn(`[lrExtractor] AI attempt ${attempt+1} produced unparseable output.`);
    }

    // small backoff before next attempt
    await sleep(400 * (attempt + 1));
  }

  // AI failed all attempts -> return empty fields (no fallback)
  console.warn("[lrExtractor] AI failed after attempts — returning empty fields (NO fallback).");
  return { ...EMPTY_OUT };
}

async function isStructuredLR(message) {
  try {
    const d = await extractDetails(message);
    console.debug && console.debug("[lrExtractor] isStructuredLR extracted:", d);
    return Boolean(d && d.truckNumber && d.to && d.weight && d.description);
  } catch (e) {
    console.error("[lrExtractor] isStructuredLR error:", e && e.message ? e.message : e);
    return false;
  }
}

module.exports = { extractDetails, isStructuredLR };
