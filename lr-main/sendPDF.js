// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const XLSX = require('xlsx');

const sendPDF = require('./sendPDF');
const generatePDFWithTemplate = require('./templateManager'); // keep as-is in your project
const logToExcel = require('./excelLogger'); // keep as-is in your project
const sendExcel = require('./sendExcel'); // keep as-is
const { extractDetails, isStructuredLR } = require('./utils/lrExtractor');
const { normalizePhone } = require('./utils/phone');

const app = express();
app.use(bodyParser.json());
app.use(express.static('templates'));

const allowedNumbersPath = path.join(__dirname, './allowedNumbers.json');
const subadminPath = path.join(__dirname, './subadmin.json');
const GENERATED_LOGS = path.join(__dirname, 'generatedLogs.xlsx');

if (!fs.existsSync(allowedNumbersPath)) fs.writeFileSync(allowedNumbersPath, JSON.stringify([], null, 2));
let allowedNumbers = JSON.parse(fs.readFileSync(allowedNumbersPath, 'utf8') || '[]');

let subadminNumbers = [];
try {
  if (fs.existsSync(subadminPath)) {
    subadminNumbers = JSON.parse(fs.readFileSync(subadminPath, 'utf8') || '[]');
    if (!Array.isArray(subadminNumbers)) subadminNumbers = [];
  }
} catch (e) {
  console.error('❌ reading subadmin.json', e.message);
}
const ADMIN_NUMBER_RAW = process.env.ADMIN_NUMBER || ''; // may be comma separated
const ADMIN_NUMBERS = (ADMIN_NUMBER_RAW.split?.(',') || []).map(s => s.trim()).filter(Boolean);

let sentNumbers = [];
let currentTemplate = 1;
let awaitingTemplateSelection = false;
let awaitingHelpSelection = false;
let awaitingMonthSelection = false;
const awaitingCancelSelection = {};
setInterval(() => {
  const now = Date.now();
  Object.keys(awaitingCancelSelection).forEach(k => {
    if (awaitingCancelSelection[k].expiresAt <= now) delete awaitingCancelSelection[k];
  });
}, 2 * 60 * 1000);

// helper to send simple text message (normalized)
async function sendWhatsAppMessage(toRaw, text) {
  try {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_TOKEN;
    if (!phoneId || !token) throw new Error('WhatsApp env missing');

    const to = normalizePhone(toRaw);
    if (!to) {
      console.error('❌ Invalid phone for sendWhatsAppMessage:', toRaw);
      return;
    }

    await axios.post(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('❌ sendWhatsAppMessage error', err?.response?.data || err.message);
  }
}

// utility functions used by cancel flow (retain original logic)
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

/* ------------------- Webhook endpoints ------------------- */
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

    const from = messages.from;
    const message = messages.text?.body?.trim();
    const adminNumbers = ADMIN_NUMBERS;

    if (!allowedNumbers.includes(from) && !adminNumbers.includes(from)) {
      console.log(`⛔ Blocked message from unauthorized number: ${from}`);
      return res.sendStatus(200);
    }

    if (typeof message !== 'string') {
      console.error('❌ Invalid message:', message);
      return res.status(400).send('Message is required');
    }

    const cleanedMessage = message.toLowerCase();
    console.log('👤 From:', from);
    console.log('💬 Message:', message);

    // Admin flows (kept simple — you can re-add original menu logic)
    if (adminNumbers.includes(from)) {
      if (['change template', 'home'].includes(cleanedMessage)) {
        awaitingTemplateSelection = true;
        const textBody = `📂 *Choose your PDF Template:*\n\n1️⃣ Template 1\n2️⃣ Template 2\n3️⃣ Template 3\n4️⃣ Template 4\n5️⃣ Template 5\n6️⃣ Template 6\n7️⃣ Template 7\n8️⃣ Template 8\n\n🟢 Reply with a number (1–8) to select.`;
        await sendWhatsAppMessage(from, textBody);
        return res.sendStatus(200);
      }
      if (awaitingTemplateSelection && /^[1-8]$/.test(cleanedMessage)) {
        currentTemplate = parseInt(cleanedMessage);
        awaitingTemplateSelection = false;
        await sendWhatsAppMessage(from, `✅ Template ${currentTemplate} selected.`);
        return res.sendStatus(200);
      }
      // admin help/menu handlers etc can be reinserted here if needed
    }

    /* ---------------- Existing goods handling ---------------- */
    const goodsKeywords = [
      'aluminium','tmt bar','scrap','plastic','battery','paper','finish','steel','plates','coil','drum',
      // (trimmed list) — keep list you had originally
    ];

    if (goodsKeywords.some(good => cleanedMessage.includes(good))) {
      if (!allowedNumbers.includes(from)) {
        console.log('🚫 Number not allowed:', from);
        return res.sendStatus(200);
      }

      if (!(await isStructuredLR(cleanedMessage))) {
        console.log('⚠ Ignored message (not LR structured):', message);
        if (ADMIN_NUMBERS.length > 0) {
          await sendWhatsAppMessage(ADMIN_NUMBERS[0], `⚠ Ignored unstructured LR from ${from}\n\nMessage: ${message}`);
        }
        return res.sendStatus(200);
      }

      const extracted = await extractDetails(cleanedMessage);
      const timeNow = new Date().toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true
      });
      const dateNow = new Date().toLocaleDateString('en-IN', { t
