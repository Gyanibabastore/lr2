
---

### ✅ Fix

We need to **robustly clean the Gemini response** before parsing:

1. Remove any backticks at the start or end.  
2. Remove any `json` language hints.  
3. Trim whitespace.  

---

Here’s the **full corrected code** with proper cleaning:

```js
const { GoogleGenerativeAI } = require("@google/generative-ai");

// 🔑 Your API Key (hardcoded)
const API_KEY = "AIzaSyBTt-wdj0YsByntwscggZ0dDRzrc7Qmc7I";

// 🔄 Choose which Gemini model to use
const MODEL_NAME = "models/gemini-2.0-flash"; // or "models/gemini-2.0-pro"

// Create Gemini client
const genAI = new GoogleGenerativeAI(API_KEY);

async function extractDetails(message) {
  console.log("📩 Received Message:", message);

  const prompt = `
You are a smart logistics parser.

Extract the following **mandatory** details from this message:

- truckNumber (which may be 9 or 10 characters long, possibly containing spaces or hyphens) 
  Example: "MH 09 HH 4512" should be returned as "MH09HH4512"
- to
- weight
- description

Also, extract the **optional** fields:
- from (this is optional but often present)
- name (if the message contains a pattern like "n - name", "n-name", " n name", " n. name", or any variation where 'n' is followed by '-' or '.' or space, and then the person's name — extract the text after it as the name value)

If truckNumber is missing, but the message contains words like "brllgada","bellgade","bellgad","bellgadi","new truck", "new tractor", or "new gadi", 
then set truckNumber to that phrase (exactly as it appears).

If the weight contains the word "fix" or similar, preserve it as-is.

Here is the message:
"${message}"

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

  try {
    console.log("⏳ Sending prompt to Gemini...");

    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);

    let resultText =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    console.log("📤 Raw Response from Gemini:\n", resultText);

    // --- CLEAN RAW RESPONSE ---
    resultText = resultText.trim();

    // Remove ```json or ``` at start/end
    resultText = resultText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
    resultText = resultText.replace(/```$/, "").trim();

    // --- PARSE JSON ---
    let extracted = {};
    try {
      extracted = JSON.parse(resultText);
      console.log("✅ Parsed JSON:", extracted);
    } catch (parseErr) {
      console.error("❌ JSON Parse Error:", parseErr.message);
      return {
        truckNumber: "",
        from: "",
        to: "",
        weight: "",
        description: "",
        name: "",
      };
    }

    // --- HANDLE SPECIAL PHRASES FOR truckNumber ---
    if (!extracted.truckNumber) {
      const lowerMsg = message.toLowerCase();
      if (lowerMsg.includes("new truck")) extracted.truckNumber = "new truck";
      else if (lowerMsg.includes("new tractor")) extracted.truckNumber = "new tractor";
      else if (lowerMsg.includes("new gadi")) extracted.truckNumber = "new gadi";
      else if (lowerMsg.includes("bellgadi")) extracted.truckNumber = "bellgadi";
      else if (lowerMsg.includes("bellgada")) extracted.truckNumber = "bellgada";
      else if (lowerMsg.includes("bellgade")) extracted.truckNumber = "bellgade";
      else if (lowerMsg.includes("bellgad")) extracted.truckNumber = "bellgad";
    }

    // Normalize truckNumber
    if (
      extracted.truckNumber &&
      !["new truck", "new tractor", "new gadi", "bellgadi", "bellgada", "bellgade", "bellgad"].includes(
        extracted.truckNumber.toLowerCase()
      )
    ) {
      extracted.truckNumber = extracted.truckNumber.replace(/[\s.-]/g, "").toUpperCase();
    }

    // Capitalize helper
    const capitalize = (str) => {
      if (!str) return "";
      return str
        .toLowerCase()
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    };

    // Capitalize fields
    if (extracted.from) extracted.from = capitalize(extracted.from);
    if (extracted.to) extracted.to = capitalize(extracted.to);
    if (extracted.description) extracted.description = capitalize(extracted.description);
    if (extracted.name) extracted.name = capitalize(extracted.name);

    // Weight handling
    if (extracted.weight) {
      if (/fix/i.test(extracted.weight)) {
        extracted.weight = extracted.weight.trim();
      } else {
        let weightNum = parseFloat(extracted.weight);
        if (!isNaN(weightNum)) {
          if (weightNum > 0 && weightNum < 100) extracted.weight = Math.round(weightNum * 1000).toString();
          else extracted.weight = Math.round(weightNum).toString();
        }
      }
    }

    return extracted;
  } catch (error) {
    console.error("❌ Error in extractDetails:", error.message);
    return {
      truckNumber: "",
      from: "",
      to: "",
      weight: "",
      description: "",
      name: "",
    };
  }
}

async function isStructuredLR(message) {
  console.log("\n🔍 Checking if message is structured LR...");
  const d = await extractDetails(message);

  if (!d.truckNumber) console.log("❌ Missing Truck Number");
  if (!d.to) console.log("❌ Missing TO Location");
  if (!d.weight) console.log("❌ Missing Weight");
  if (!d.description) console.log("❌ Missing Description");

  const isValid = d.truckNumber && d.to && d.weight && d.description;
  console.log("✅ isStructuredLR:", isValid);
  return isValid;
}

// Example usage
(async () => {
  const testMsg = `Rj 27 GB 7961
wt 30
Mh to Mungana/choti sadri
Tmt
N.grp`;
  const details = await extractDetails(testMsg);
  console.log("🎯 Extracted Details:", details);

  const valid = await isStructuredLR(testMsg);
  console.log("Structured LR:", valid);
})();

module.exports = { extractDetails, isStructuredLR };
