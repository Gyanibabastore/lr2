// sendPDF.js
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const subadminPath = path.join(__dirname, './subadmin.json');

// Improved normalize function (E.164)
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
  const adminNumber = process.env.ADMIN_NUMBER;

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
    // Normalize numbers before use
    const userNumber = normalizePhone(to);
    if (!userNumber) throw new Error(`Invalid recipient phone after normalization: "${to}"`);
    const adminNumberFixed = normalizePhone(adminNumber);
    const subadminNumbersFixed = (subadminNumbers || []).map(n => normalizePhone(n)).filter(Boolean);

    console.log("📤 Sending PDF to:", userNumber);

    const fileName = `${truckNumber || 'LR'}.pdf`;
    const tempDir = path.join(__dirname, 'temp');
    const renamedPath = path.join(tempDir, fileName);

    fs.mkdirSync(tempDir, { recursive: true });
    fs.copyFileSync(filePath, renamedPath);

    // Upload PDF to WhatsApp (media)
    const form = new FormData();
    form.append('file', fs.createReadStream(renamedPath));
    form.append('type', 'application/pdf');
    form.append('messaging_product', 'whatsapp');

    console.log("🔁 Uploading media to WhatsApp...");

    const uploadRes = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );

    const mediaId = uploadRes.data?.id;
    if (!mediaId) throw new Error("Media upload failed: missing media id");
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

    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      userPayload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log("✅ PDF sent to user:", userNumber);

    // Send to admin + subadmins
    const extraRecipients = [adminNumberFixed, ...subadminNumbersFixed].filter(Boolean);

    for (const number of extraRecipients) {
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
      try {
        await axios.post(
          `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );
        console.log(`✅ PDF sent to admin/subadmin: ${number}`);
      } catch (e) {
        console.error(`⚠️ Failed to send to admin/subadmin ${number}:`, e?.response?.data || e.message);
      }
    }

    // Cleanup
    try { fs.unlinkSync(renamedPath); } catch (e) { /* ignore */ }
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log("🗑 Deleted original generated PDF:", filePath);
      }
    } catch (e) { /* ignore */ }

  } catch (err) {
    const errorMessage = err.response?.data?.error?.message || err.message;
    console.error("❌ Error sending PDF:", errorMessage);

    // Notify admin of failure
    if (adminNumber) {
      const adminNormalized = normalizePhone(adminNumber);
      if (adminNormalized) {
        const failMsg = `❌ *PDF failed to send*\nTo: ${to}\nReason: ${errorMessage}\n\n📝 ${originalMessage}`;
        try {
          await axios.post(
            `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: "whatsapp",
              to: adminNormalized,
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
          console.error("⚠️ Failed to notify admin about the PDF send error:", e?.response?.data || e.message);
        }
      } else {
        console.warn("⚠️ Admin number invalid, cannot notify:", adminNumber);
      }
    }
  }
}

// keep module.exports as function (so existing require() keeps working)
module.exports = sendPDF;
// also attach normalize for external access if someone wants it
module.exports.normalizePhone = normalizePhone;
