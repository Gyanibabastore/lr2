// sendPDF.js
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const subadminPath = path.join(__dirname, './subadmin.json');

// Normalize phone helper (same logic as app.js, self-contained)
function normalizePhone(input, defaultCountry = "91") {
  if (input === undefined || input === null || input === "") return null;
  let s = String(input).trim();
  s = s.replace(/\uFF0B/g, "+");
  if (s.startsWith("+")) {
    s = "+" + s.slice(1).replace(/\D/g, "");
  } else {
    s = s.replace(/\D/g, "");
  }
  s = s.replace(/^\+?0+/, (m) => (m.startsWith("+") ? "+" : ""));
  if (!s.startsWith("+")) {
    if (s.length === 12 && s.startsWith(defaultCountry)) s = `+${s}`;
    else if (s.length === 10) s = `+${defaultCountry}${s}`;
    else s = `+${defaultCountry}${s}`;
  }
  if (!/^\+\d{6,15}$/.test(s)) return null;
  return s;
}

async function sendPDF(to, filePath, templateNumber = null, originalMessage = '', truckNumber = null) {
  const adminNumberEnv = process.env.ADMIN_NUMBER || ""; // raw env (may be comma-separated)
  let adminNumberFixed = null;

  // read subadmins
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

  try {
    // Normalize recipient numbers
    const userNumber = normalizePhone(to);
    adminNumberFixed = normalizePhone(adminNumberEnv.split(',')[0] || "");
    const subadminNumbersFixed = (subadminNumbers || []).map(n => normalizePhone(n)).filter(Boolean);

    if (!userNumber) throw new Error("Invalid user phone number");

    console.log("📤 Sending PDF to:", userNumber);

    const fileName = `${truckNumber || 'LR'}.pdf`;
    const tempDir = path.join(__dirname, 'temp');
    const renamedPath = path.join(tempDir, fileName);

    fs.mkdirSync(tempDir, { recursive: true });
    fs.copyFileSync(filePath, renamedPath);

    // Upload PDF to WhatsApp
    console.log("🔁 Uploading media to WhatsApp...");
    const form = new FormData();
    form.append('file', fs.createReadStream(renamedPath));
    form.append('type', 'application/pdf');
    form.append('messaging_product', 'whatsapp');

    const uploadRes = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          ...form.getHeaders(),
        },
      }
    );

    const mediaId = uploadRes.data.id;
    console.log("📎 Media uploaded. ID:", mediaId);

    // Send to user
    const userPayload = {
      messaging_product: "whatsapp",
      to: userNumber,
      type: "document",
      document: {
        id: mediaId,
        caption: `\nDate: ${new Date().toLocaleDateString()}`,
        filename: fileName,
      },
    };
    console.log("➡️ Payload for user:", JSON.stringify(userPayload));
    await axios.post(`https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`, userPayload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log("✅ PDF sent to user:", userNumber);

    // Send to admin + subadmins (normalize & dedupe)
    const adminListRaw = [];
    if (adminNumberFixed) adminListRaw.push(adminNumberFixed);
    adminListRaw.push(...subadminNumbersFixed);

    const uniqueAdmins = Array.from(new Set(adminListRaw.map(n => normalizePhone(n)).filter(Boolean)));

    for (const number of uniqueAdmins) {
      if (!number) continue;
      const payload = {
        messaging_product: "whatsapp",
        to: number,
        type: "document",
        document: {
          id: mediaId,
          caption: `📄 LR\nT: ${templateNumber || '-'}\nMobile: ${userNumber}\nDate: ${new Date().toLocaleDateString()}\n\n📝 ${originalMessage}`,
          filename: fileName,
        },
      };
      console.log(`➡️ Payload for admin/subadmin ${number}:`, JSON.stringify(payload));
      await axios.post(`https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`, payload, {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      console.log(`✅ PDF sent to admin/subadmin: ${number}`);
    }

    // Cleanup
    try { fs.unlinkSync(renamedPath); } catch(e){}
    try { if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); console.log("🗑 Deleted original generated PDF:", filePath); } } catch(e){}

  } catch (err) {
    const errorMessage = err.response?.data?.error?.message || err.message;
    console.error("❌ Error sending PDF:", errorMessage);

    // Notify admin of failure (first admin only)
    const adminNumber = normalizePhone((process.env.ADMIN_NUMBER || "").split(',')[0] || "");
    if (adminNumber) {
      const failMsg = `❌ *PDF failed to send*\nTo: ${to}\nReason: ${errorMessage}\n\n📝 ${originalMessage}`;
      try {
        await axios.post(
          `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: adminNumber,
            text: { body: failMsg },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );
      } catch (e) {
        console.error("❌ Failed to notify admin about the failure:", e?.response?.data || e.message);
      }
    }
  }
}

module.exports = sendPDF;
