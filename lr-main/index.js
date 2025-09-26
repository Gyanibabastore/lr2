// app.js
const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();
const sendPDF = require('./sendPDF');
const generatePDFWithTemplate = require('./templateManager');
const { extractDetails, isStructuredLR } = require('./utils/lrExtractor');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logToExcel = require('./excelLogger');
const sendExcel = require('./sendExcel');
const XLSX = require('xlsx');

const app = express();
app.use(bodyParser.json());
app.use(express.static("templates"));

/* ------------------- Normalizer (E.164) ------------------- */
function normalizePhone(input, defaultCountry = "91") {
  if (input === undefined || input === null || input === "") return null;
  let s = String(input).trim();
  // Replace fullwidth plus sign if any
  s = s.replace(/\uFF0B/g, "+");
  // If starts with +, keep digits only after +
  if (s.startsWith("+")) {
    s = "+" + s.slice(1).replace(/\D/g, "");
  } else {
    s = s.replace(/\D/g, "");
  }
  // strip leading zeros
  s = s.replace(/^\+?0+/, (m) => (m.startsWith("+") ? "+" : ""));
  // add country prefix if missing or fix common lengths
  if (!s.startsWith("+")) {
    if (s.length === 12 && s.startsWith(defaultCountry)) s = `+${s}`;
    else if (s.length === 10) s = `+${defaultCountry}${s}`;
    else s = `+${defaultCountry}${s}`;
  }
  if (!/^\+\d{6,15}$/.test(s)) return null;
  return s;
}

/* ------------------- Config / Existing state ------------------- */
const ADMIN_NUMBERS_RAW = process.env.ADMIN_NUMBER || ""; // comma-separated or single
const allowedNumbersPath = path.join(__dirname, './allowedNumbers.json');
const subadminPath = path.join(__dirname, './subadmin.json');

let subadminNumbers = [];
try {
  if (fs.existsSync(subadminPath)) {
    subadminNumbers = JSON.parse(fs.readFileSync(subadminPath, 'utf8'));
    if (!Array.isArray(subadminNumbers)) {
      console.error("❌ subadmin.json must be an array of numbers");
      subadminNumbers = [];
    }
  }
} catch (err) {
  console.error("❌ Error reading subadmin.json:", err.message);
  subadminNumbers = [];
}

// Normalize admin(s) and subadmin list
const ADMIN_ARRAY = ADMIN_NUMBERS_RAW
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(n => normalizePhone(n))
  .filter(Boolean);

subadminNumbers = (subadminNumbers || []).map(n => normalizePhone(n)).filter(Boolean);

let allNumber = [...ADMIN_ARRAY, ...subadminNumbers].filter(Boolean);
function updateAllNumbers() {
  allNumber = [...ADMIN_ARRAY, ...subadminNumbers].filter(Boolean);
}

if (!fs.existsSync(allowedNumbersPath)) {
  fs.writeFileSync(allowedNumbersPath, JSON.stringify([], null, 2));
}
let allowedNumbers = JSON.parse(fs.readFileSync(allowedNumbersPath, 'utf8')) || [];
// normalize allowedNumbers
allowedNumbers = (allowedNumbers || []).map(n => normalizePhone(n)).filter(Boolean);

function saveAllowedNumbers() {
  fs.writeFileSync(allowedNumbersPath, JSON.stringify(allowedNumbers, null, 2));
}

function saveSubadmins() {
  fs.writeFileSync(subadminPath, JSON.stringify(subadminNumbers, null, 2));
  updateAllNumbers();
}

/* ------------------- runtime state ------------------- */
let sentNumbers = [];
let currentTemplate = 1;
let awaitingTemplateSelection = false;
let awaitingHelpSelection = false;
let awaitingMonthSelection = false;

/* ------------------- WhatsApp send helper (normalize + log) ------------------- */
async function sendWhatsAppMessage(to, text) {
  try {
    const toNormalized = normalizePhone(to);
    if (!toNormalized) {
      console.warn("❗ sendWhatsAppMessage: invalid recipient, skipping:", to);
      return;
    }
    const payload = {
      messaging_product: "whatsapp",
      to: toNormalized,
      text: { body: text },
    };
    console.log("➡️ Sending WhatsApp payload:", JSON.stringify(payload));
    const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;
    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log("⬅️ FB response:", res.status, JSON.stringify(res.data));
  } catch (err) {
    console.error('❌ sendWhatsAppMessage error', err?.response?.data || err.message);
  }
}

/* ------------------- Cancel-feature helpers ------------------- */
const GENERATED_LOGS = path.join(__dirname, 'generatedLogs.xlsx');
function getISTDate() {
  const nowUTC = new Date();
  return new Date(nowUTC.getTime() + (5.5 * 60 * 60 * 1000));
}
function parseINDateTime(dateStr, timeStr) {
  try {
    const [d, m, y] = String(dateStr).split('/').map(s => s.padStart(2, '0'));
    if (!d || !m || !y) return null;
    const [timePart, ampm] = String(timeStr).split(' ');
    const [hh, mm] = (timePart || '00:00').split(':').map(s => s.padStart(2, '0'));
    let hour = parseInt(hh, 10);
    if (ampm && ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (ampm && ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
    return new Date(Date.UTC(
      parseInt(y, 10),
      parseInt(m, 10) - 1,
      parseInt(d, 10),
      hour - 5,
      parseInt(mm, 10)
    ));
  } catch (e) {
    return null;
  }
}
function findRecentRowsForMobile(excelPath, mobile) {
  if (!fs.existsSync(excelPath)) return [];
  const workbook = XLSX.readFile(excelPath);
  const results = [];
  const now = getISTDate();
  const targetMobile = String(mobile || '').replace(/\D/g, '');
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    rows.forEach((row, idx) => {
      const rowMobileRaw = row.Mobile || row['Mobile'] || row['Mobile No'] || row['Phone'] || '';
      if (!rowMobileRaw) return;
      const rowMobile = String(rowMobileRaw).replace(/\D/g, '');
      if (rowMobile !== targetMobile) return;
      const dt = parseINDateTime(String(row.Date || ''), String(row.Time || ''));
      if (!dt) return;
      const diff = now - dt;
      if (diff >= 0 && diff <= 24 * 60 * 60 * 1000) {
        results.push({ sheetName, rowIndex: idx, row, dt });
      }
    });
  });
  console.log(results);
  return results;
}
function markRowsCancelled(excelPath, mobile, targetRow) {
  if (!fs.existsSync(excelPath)) return { updated: 0, message: 'No file' };
  const workbook = XLSX.readFile(excelPath);
  const now = new Date();
  let updated = 0;
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const newRows = rows.map(r => {
      try {
        const rowMobile = String(r.Mobile || r['Mobile'] || '').trim();
        if (rowMobile !== mobile) return r;
        const dt = parseINDateTime(String(r.Date || ''), String(r.Time || ''));
        if (!dt || now - dt > 24 * 60 * 60 * 1000) return r;
        const targetTruck = String(targetRow.row['Truck No'] || '').trim();
        const matchTruck = String(r['Truck No'] || '').trim() === targetTruck;
        const matchWeight = String(r.Weight || '').trim() === String(targetRow.row.Weight || '').trim();
        const matchTime = String(r.Time || '').trim() === String(targetRow.row.Time || '').trim();
        if (matchTruck && matchWeight && matchTime) {
          r.Cancelled = 'Yes';
          if (r.Status) {
            if (!String(r.Status).toLowerCase().includes('cancel')) {
              r.Status = `${r.Status} (Cancelled)`;
            }
          } else {
            r.Status = 'Cancelled';
          }
          updated++;
        }
      } catch (e) {}
      return r;
    });
    if (updated > 0) {
      const newSheet = XLSX.utils.json_to_sheet(newRows);
      workbook.Sheets[sheetName] = newSheet;
    }
  });
  if (updated > 0) XLSX.writeFile(workbook, excelPath);
  return { updated };
}

const awaitingCancelSelection = {};
setInterval(() => {
  const now = Date.now();
  Object.keys(awaitingCancelSelection).forEach(k => {
    if (awaitingCancelSelection[k].expiresAt <= now) delete awaitingCancelSelection[k];
  });
}, 60 * 1000 * 2);

/* ------------------- Webhook Endpoints ------------------- */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const messages = changes?.messages?.[0];
    if (!messages) return res.sendStatus(200);

    // normalize incoming 'from' immediately
    const rawFrom = messages.from;
    const from = normalizePhone(rawFrom);
    if (!from) {
      console.warn("Invalid sender number from webhook:", rawFrom);
      return res.sendStatus(400);
    }

    const message = messages.text?.body?.trim();
    const adminNumbers = ADMIN_ARRAY; // already normalized

    if (!allowedNumbers.includes(from) && !adminNumbers.includes(from) && !allNumber.includes(from)) {
      console.log(`⛔ Blocked message from unauthorized number: ${from}`);
      return res.sendStatus(200);
    }

    if (typeof message !== 'string') {
      console.error('❌ Invalid message:', message);
      return res.status(400).send('Message is required');
    }

    const cleanedMessage = message.toLowerCase();
    console.log("👤 From:", from);
    console.log("💬 Message:", message);
    console.log("🧼 Cleaned:", cleanedMessage);
    console.log("🔧 Admins:", adminNumbers);

    /* ---------------- Admin-only flows ---------------- */
    if (adminNumbers.includes(from)) {
      if (['change template', 'home'].includes(cleanedMessage)) {
        awaitingTemplateSelection = true;
        const textBody = `📂 *Choose your PDF Template:*\n\n` +
          `1️⃣ Template 1\n2️⃣ Template 2\n3️⃣ Template 3\n4️⃣ Template 4\n` +
          `5️⃣ Template 5\n6️⃣ Template 6\n7️⃣ Template 7\n8️⃣ Template 8\n\n` +
          `🟢 *Reply with a number (1–8) to select.*`;
        await sendWhatsAppMessage(from, textBody);
        return res.sendStatus(200);
      }

      if (awaitingTemplateSelection && /^[1-8]$/.test(cleanedMessage)) {
        currentTemplate = parseInt(cleanedMessage);
        awaitingTemplateSelection = false;
        await sendWhatsAppMessage(from, `✅ Template ${currentTemplate} selected.`);
        return res.sendStatus(200);
      }

      if (cleanedMessage === 'help') {
        awaitingTemplateSelection = false;
        awaitingHelpSelection = false;
        awaitingMonthSelection = false;
        const helpMsg =
`🛠️ *Admin Control Panel*  
━━━━━━━━━━━━━━━━━━  
1️⃣ Change Template  
2️⃣ Add Number  
3️⃣ Remove Number  
4️⃣ List Allowed Numbers  
5️⃣ Send Excel Log to Admin  
━━━━━━━━━━━━━━━━━━  
👥 *Subadmin Control Panel*  
6️⃣ Add Subadmin  
7️⃣ Remove Subadmin  
8️⃣ List Subadmins  
━━━━━━━━━━━━━━━━━━  

🟢 *Reply with 1–8 to choose a command.*`;
        awaitingHelpSelection = true;
        await sendWhatsAppMessage(from, helpMsg);
        return res.sendStatus(200);
      }

      if (awaitingHelpSelection) {
        // admin interactive menu handling (you can keep your existing implementation here)
        // for brevity this block is not expanded here — keep your existing add/remove/list flows
      }
    }

    /* ---------------- Existing goods handling ---------------- */
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
      'finishu','finisih','finis','finnish','finsh','finush','fnish','funish','plates','plate','iron','iran',
    ];

    if (goodsKeywords.some(good => cleanedMessage.includes(good))) {
      if (!allowedNumbers.includes(from)) {
        console.log("🚫 Number not allowed:", from);
        return res.sendStatus(200);
      }

      // STRICT LR check (Gemini-first and fallback inside)
      if (!(await isStructuredLR(cleanedMessage))) {
        console.log("⚠️ Ignored message (not LR structured):", message);
        if (ADMIN_ARRAY.length > 0) {
          await sendWhatsAppMessage(ADMIN_ARRAY[0], `⚠️ Ignored unstructured LR from ${from}\n\nMessage: ${message}`);
        }
        return res.sendStatus(200);
      }

      const extracted = await extractDetails(cleanedMessage);
      const timeNow = new Date().toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true
      });
      const dateNow = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

      const lrData = { ...extracted, time: timeNow, date: dateNow };

      try {
        const pdfPath = await generatePDFWithTemplate(currentTemplate, lrData, message);
        await sendPDF(from, pdfPath, currentTemplate, message, lrData.truckNumber);
        logToExcel({
          Date: dateNow, Time: timeNow, 'Truck No': lrData.truckNumber,
          From: lrData.from, To: lrData.to, Weight: lrData.weight,
          Description: lrData.description, name: lrData.name,
          Template: currentTemplate, Mobile: from
        });
      } catch (err) {
        console.error("❌ PDF Error:", err.message);
        if (ADMIN_ARRAY.length > 0) {
          await sendWhatsAppMessage(ADMIN_ARRAY[0], `❌ Failed to generate/send PDF for ${from}`);
        }
      }
      if (!sentNumbers.includes(from)) sentNumbers.push(from);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ webhook handling error', err);
    return res.sendStatus(500);
  }
});

app.get('/sent-numbers', (req, res) => {
  res.json({ sentNumbers });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Webhook server running on http://localhost:${PORT}`);
});
