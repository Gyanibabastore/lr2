const { GoogleGenerativeAI } = require("@google/generative-ai");

const API_KEY = "AIzaSyBTt-wdj0YsByntwscggZ0dDRzrc7Qmc7I";
const MODEL_NAME = "models/gemini-2.0-flash";

const genAI = new GoogleGenerativeAI(API_KEY);

async function extractDetails(message) {
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
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);
    let resultText =
      result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    resultText = resultText.trim();
    resultText = resultText.replace(/^json\s*/i, "").replace(/^\s*/i, "");
    resultText = resultText.replace(/```$/, "").trim();

    let extracted = {};
    try {
      extracted = JSON.parse(resultText);
    } catch {
      return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
    }

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

    if (
      extracted.truckNumber &&
      !["new truck", "new tractor", "new gadi", "bellgadi", "bellgada", "bellgade", "bellgad"].includes(
        extracted.truckNumber.toLowerCase()
      )
    ) {
      extracted.truckNumber = extracted.truckNumber.replace(/[\s.-]/g, "").toUpperCase();
    }

    const capitalize = (str) => {
      if (!str) return "";
      return str
        .toLowerCase()
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    };

    if (extracted.from) extracted.from = capitalize(extracted.from);
    if (extracted.to) extracted.to = capitalize(extracted.to);
    if (extracted.description) extracted.description = capitalize(extracted.description);
    if (extracted.name) extracted.name = capitalize(extracted.name);

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
  } catch {
    return { truckNumber: "", from: "", to: "", weight: "", description: "", name: "" };
  }
}

async function isStructuredLR(message) {
  const d = await extractDetails(message);
  return d.truckNumber && d.to && d.weight && d.description;
}

module.exports = { extractDetails, isStructuredLR };
