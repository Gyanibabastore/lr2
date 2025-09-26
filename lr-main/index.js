// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sendPDF = require('./sendPDF');
const generatePDFWithTemplate = require('./templateManager');
const { extractDetails, isStructuredLR } = require('./utils/lrExtractor');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logToExcel = require('./excelLogger');
const sendExcel = require('./sendExcel');
const XLSX = require('xlsx');
const { normalizePhone } = require('./utils/phone');

const app = express();
app.use(bodyParser.json());
app.use(express.static("templates"));

/* ------------------- Config / Existing state ------------------- */
const ADMIN_NUMBERS = process.env.ADMIN_NUMBER; // can be comma-separated
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
}

let allNumber = [ADMIN_NUMBERS, ...subadminNumbers].filter(Boolean);
function updateAllNumbers() {
  allNumber = [ADMIN_NUMBERS, ...subadminNumbers].filter(Boolean);
}

if (!fs.existsSync(allowedNumbersPath)) {
  fs.writeFileSync(allowedNumbersPath, JSON.stringify([], null, 2));
}
let allowedNumbers = [];
try {
  allowedNumbers = JSON.parse(fs.readFileSync(allowedNumbersPath, 'utf8'));
} catch (e) {
  allowedNumbers = [];
}

let sentNumbers = [];
let currentTemplate = 4;
let awaitingTemplateSelection = false;
let awaitingHelpSelection = false;
let awaitingMonthSelection = false;

function saveAllowedNumbers() {
  fs.writeFileSync(allowedNumbersPath, JSON.stringify(allowedNumbers, null, 2));
}

function saveSubadmins() {
  fs.writeFileSync(subadminPath, JSON.stringify(subadminNumbers, null, 2));
}

/* ------------------- WhatsApp send helper ------------------- */
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

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
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

    const from = messages.from;
    const message = messages.text?.body?.trim();
    const adminNumbers = (process.env.ADMIN_NUMBER || '').split(',').map(s => s.trim()).filter(Boolean);

    if (!allowedNumbers.includes(from) && !adminNumbers.includes(from)) {
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
        const textBody = `📂 *Choose your PDF Template:*\n\n1️⃣ Template 1\n2️⃣ Template 2\n3️⃣ Template 3\n4️⃣ Template 4\n5️⃣ Template 5\n6️⃣ Template 6\n7️⃣ Template 7\n8️⃣ Template 8\n\n🟢 *Reply with a number (1–8) to select.*`;
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
`🛠 Admin Control Panel  
━━━━━━━━━━━━━━━━━━  
1️⃣ Change Template  
2️⃣ Add Number  
3️⃣ Remove Number  
4️⃣ List Allowed Numbers  
5️⃣ Send Excel Log to Admin  
━━━━━━━━━━━━━━━━━━  
👥 Subadmin Control Panel  
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
        if (cleanedMessage === '1' || cleanedMessage === '1️⃣') {
          awaitingHelpSelection = false;
          awaitingTemplateSelection = true;
          await sendWhatsAppMessage(from, `📂 Reply with template number (1-8).`);
          return res.sendStatus(200);
        }
        if (cleanedMessage === '2' || cleanedMessage === '2️⃣') {
          awaitingHelpSelection = false;
          await sendWhatsAppMessage(from, `ℹ Usage: add <number> example: add 919876543210`);
          return res.sendStatus(200);
        }
        if (cleanedMessage === '3' || cleanedMessage === '3️⃣') {
          awaitingHelpSelection = false;
          await sendWhatsAppMessage(from, `ℹ Usage: remove <number> example: remove 919876543210`);
          return res.sendStatus(200);
        }
        if (cleanedMessage === '4' || cleanedMessage === '4️⃣') {
          awaitingHelpSelection = false;
          if (allowedNumbers.length === 0) {
            await sendWhatsAppMessage(from, `📃 No numbers in allowed list.`);
            return res.sendStatus(200);
          }
          let chunks = [], cur = '';
          allowedNumbers.forEach((num, i) => {
            const line = `${i + 1}. ${num}\n`;
            if ((cur + line).length >= 3900) { chunks.push(cur); cur = ''; }
            cur += line;
          });
          if (cur) chunks.push(cur);
          for (let i = 0; i < chunks.length; i++) {
            await sendWhatsAppMessage(from, `📃 *Allowed Numbers (Page ${i+1}/${chunks.length}):*\n\n${chunks[i]}`);
          }
          return res.sendStatus(200);
        }
        if (cleanedMessage === '5' || cleanedMessage === '5️⃣') {
          awaitingHelpSelection = false;
          try {
            const excelPath = path.join(__dirname, 'generatedLogs.xlsx');
            const now = new Date();
            const monthYear = now.toLocaleString('default', { month: 'long', year: 'numeric' });
            if (!fs.existsSync(excelPath)) {
              await sendWhatsAppMessage(from, `⚠ *Excel log file not found.*`);
              return res.sendStatus(200);
            }
            const workbook = XLSX.readFile(excelPath);
            if (!workbook.SheetNames.includes(monthYear)) {
              await sendWhatsAppMessage(from, `📁 *No log found for ${monthYear}.*`);
              return res.sendStatus(200);
            }
            const tempWorkbook = XLSX.utils.book_new();
            tempWorkbook.SheetNames.push(monthYear);
            tempWorkbook.Sheets[monthYear] = workbook.Sheets[monthYear];
            const tempFilePath = path.join(__dirname, `Rudransh_Trading_${monthYear.replace(' ', '_')}.xlsx`);
            XLSX.writeFile(tempWorkbook, tempFilePath);
            await sendExcel(from, tempFilePath, `📊 *Here is your log for ${monthYear}.*`);
            fs.unlinkSync(tempFilePath);
          } catch (err) {
            console.error('❌ Error sending Excel log:', err.message || err);
            await sendWhatsAppMessage(from, `❌ *Failed to send monthly Excel log.*`);
          }
          return res.sendStatus(200);
        }
        // Subadmin Options
        if (cleanedMessage === '6' || cleanedMessage === '6️⃣') {
          awaitingHelpSelection = false;
          await sendWhatsAppMessage(from, `ℹ Usage: new <number>`);
          return res.sendStatus(200);
        }
        if (cleanedMessage === '7' || cleanedMessage === '7️⃣') {
          awaitingHelpSelection = false;
          await sendWhatsAppMessage(from, `ℹ Usage: delete <number>`);
          return res.sendStatus(200);
        }
        if (cleanedMessage === '8' || cleanedMessage === '8️⃣') {
          awaitingHelpSelection = false;
          if (subadminNumbers.length === 0) {
            await sendWhatsAppMessage(from, `📃 No Subadmin numbers found.`);
            return res.sendStatus(200);
          }
          let chunks = [], cur = '';
          subadminNumbers.forEach((num, i) => {
            const line = `${i + 1}. ${num}\n`;
            if ((cur + line).length >= 3900) { chunks.push(cur); cur = ''; }
            cur += line;
          });
          if (cur) chunks.push(cur);
          for (let i = 0; i < chunks.length; i++) {
            await sendWhatsAppMessage(from, `👥 *Subadmin List (Page ${i+1}/${chunks.length}):*\n\n${chunks[i]}`);
          }
          return res.sendStatus(200);
        }
        awaitingHelpSelection = false;
        await sendWhatsAppMessage(from, `⚠ Unknown option. Send *help* to open Admin menu again.`);
        return res.sendStatus(200);
      }
    }

    /* ---------- Admin add/remove/list commands ---------- */
    if (adminNumbers.includes(from)) {
      if (cleanedMessage.startsWith('add ')) {
        const parts = message.split(' ').filter(Boolean);
        const numberToAdd = parts[1];
        if (!numberToAdd || !/^91\d{10}$/.test(numberToAdd)) {
          await sendWhatsAppMessage(from, `ℹ Usage: add <number> e.g. add 919876543210`);
          return res.sendStatus(200);
        }
        if (allowedNumbers.includes(numberToAdd)) {
          await sendWhatsAppMessage(from, `ℹ Number already exists: ${numberToAdd}`);
          return res.sendStatus(200);
        }
        allowedNumbers.push(numberToAdd);
        saveAllowedNumbers();
        await sendWhatsAppMessage(from, `✅ Number added: ${numberToAdd}`);
        return res.sendStatus(200);
      }

      if (cleanedMessage.startsWith('remove ')) {
        const parts = message.split(' ').filter(Boolean);
        const numberToRemove = parts[1];
        if (!numberToRemove) {
          await sendWhatsAppMessage(from, `ℹ Usage: remove <number>`);
          return res.sendStatus(200);
        }
        if (!allowedNumbers.includes(numberToRemove)) {
          await sendWhatsAppMessage(from, `⚠ Number not found: ${numberToRemove}`);
          return res.sendStatus(200);
        }
        await sendWhatsAppMessage(from, `⚠ Confirm removal of ${numberToRemove} by sending: confirm remove ${numberToRemove}`);
        return res.sendStatus(200);
      }

      if (cleanedMessage.startsWith('confirm remove ')) {
        const parts = message.split(' ').filter(Boolean);
        const numberToRemove = parts[2];
        if (!numberToRemove) {
          await sendWhatsAppMessage(from, `❗ Usage: confirm remove <number>`);
          return res.sendStatus(200);
        }
        if (!allowedNumbers.includes(numberToRemove)) {
          await sendWhatsAppMessage(from, `⚠ Number not found: ${numberToRemove}`);
          return res.sendStatus(200);
        }
        allowedNumbers = allowedNumbers.filter(n => n !== numberToRemove);
        saveAllowedNumbers();
        await sendWhatsAppMessage(from, `🗑 Number removed: ${numberToRemove}`);
        return res.sendStatus(200);
      }

      // Subadmin Commands
      if (cleanedMessage.startsWith('new ')) {
        const parts = message.split(' ').filter(Boolean);
        const numberToAdd = parts[1];
        console.log(numberToAdd);
        if (!numberToAdd || !/^91\d{10}$/.test(numberToAdd)) {
          await sendWhatsAppMessage(from, `❌ Invalid format. Usage: new 91XXXXXXXXXX`);
          return res.sendStatus(200);
        }
        if (subadminNumbers.includes(numberToAdd)) {
          await sendWhatsAppMessage(from, `ℹ Number already a subadmin: ${numberToAdd}`);
          return res.sendStatus(200);
        }
        subadminNumbers.push(numberToAdd);
        saveSubadmins();
        updateAllNumbers();
        await sendWhatsAppMessage(from, `✅ Subadmin added: ${numberToAdd}`);
        return res.sendStatus(200);
      }

      if (cleanedMessage.startsWith('delete ')) {
        const parts = message.split(' ').filter(Boolean);
        const numberToRemove = parts[1];
        if (!subadminNumbers.includes(numberToRemove)) {
          await sendWhatsAppMessage(from, `⚠ Subadmin not found: ${numberToRemove}`);
          return res.sendStatus(200);
        }
        await sendWhatsAppMessage(from, `⚠ Confirm removal of subadmin ${numberToRemove} by sending: confirm delete ${numberToRemove}`);
        return res.sendStatus(200);
      }

      if (cleanedMessage.startsWith('confirm delete ')) {
        const parts = message.split(' ').filter(Boolean);
        const numberToRemove = parts[2];
        if (!subadminNumbers.includes(numberToRemove)) {
          await sendWhatsAppMessage(from, `⚠ Subadmin not found: ${numberToRemove}`);
          return res.sendStatus(200);
        }
        subadminNumbers = subadminNumbers.filter(n => n !== numberToRemove);
        saveSubadmins();
        updateAllNumbers();
        await sendWhatsAppMessage(from, `🗑 Subadmin removed: ${numberToRemove}`);
        return res.sendStatus(200);
      }
    }

    /* ---------------- User cancel flow (allowed users) ---------------- */
    if ((cleanedMessage === 'cancel' || cleanedMessage === 'cancle') && (allowedNumbers.includes(from) || allNumber.includes(from))) {
      const found = findRecentRowsForMobile(GENERATED_LOGS, from);
      if (!found || found.length === 0) {
        await sendWhatsAppMessage(from, `ℹ No records found for your number in the last 24 hours.`);
        return res.sendStatus(200);
      }

      let reply = `📋 *Your records from last 24 hours:*\n\n`;
      const items = [];
      found.forEach((f, idx) => {
        const row = f.row;
        const isCancelled = String(row.Cancelled || row.cancelled || '').toLowerCase() === 'yes';
        const status = isCancelled ? '❌ Already Cancelled' : '✅ Active';
        reply += `${idx + 1}) Truck No: ${row['Truck No'] || ''}\n   Weight: ${row.Weight || ''}\n   Time: ${row.Time || ''}\n   Status: ${status}\n\n`;
        items.push(f);
      });
      reply += `🟢 Reply with the *number* (e.g. 1) to cancel that record.\n❗ Records already cancelled cannot be cancelled again.`;

      awaitingCancelSelection[from] = { items, expiresAt: Date.now() + 5 * 60 * 1000 };
      await sendWhatsAppMessage(from, reply);
      return res.sendStatus(200);
    }

    if (/^\d+$/.test(cleanedMessage) && awaitingCancelSelection[from]) {
      const idx = parseInt(cleanedMessage, 10) - 1;
      const sel = awaitingCancelSelection[from];
      if (!sel.items || !sel.items[idx]) {
        await sendWhatsAppMessage(from, `⚠ Invalid selection. Please send the number shown in the list you received.`);
        return res.sendStatus(200);
      }
      const target = sel.items[idx];
      if (target.row.cancelled) {
        await sendWhatsAppMessage(from, `ℹ This record is *already cancelled*:\nTruck No: ${target.row['Truck No'] || ''}\nWeight: ${target.row.Weight || ''}\nTime: ${target.row.Time || ''}`);
        delete awaitingCancelSelection[from];
        return res.sendStatus(200);
      }
      const result = markRowsCancelled(GENERATED_LOGS, from, target);
      delete awaitingCancelSelection[from];
      if (result.updated && result.updated > 0) {
        const row = target.row;
        await sendWhatsAppMessage(from, `✅ Cancelled ${result.updated} record(s):\nTruck No: ${row['Truck No'] || ''}\nWeight: ${row.Weight || ''}\nTime: ${row.Time || ''}`);
        for (const adm of allNumber) {
          await sendWhatsAppMessage(adm, `📢 ${from} cancelled ${result.updated} record(s):\nTruck No: ${row['Truck No'] || ''}\nWeight: ${row.Weight || ''}\nTime: ${row.Time || ''}`);
        }
      } else {
        await sendWhatsAppMessage(from, `ℹ No matching recent records found to cancel (they may be older than 24h).`);
      }
      return res.sendStatus(200);
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

      // Keep original structured check, but defensive: try to extract and if AI fails do not ignore outright
      const extractedForCheck = await extractDetails(cleanedMessage);
      if (!(extractedForCheck.truckNumber && extractedForCheck.to && extractedForCheck.weight && extractedForCheck.description)) {
        // Log and continue to attempt processing (don't return). This prevents ignoring valid messages due to parser failure.
        console.log("⚠ Parser incomplete for message, proceeding with best-effort extraction:", message);
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
        console.error("❌ PDF Error:", err.message || err);
        if (ADMIN_NUMBERS && ADMIN_NUMBERS.length > 0) {
          await sendWhatsAppMessage(ADMIN_NUMBERS.split?.(',')[0] || ADMIN_NUMBERS, `❌ Failed to generate/send PDF for ${from}`);
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
