// sendPDF.js
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const subadminPath = path.join(__dirname, './subadmin.json');

// Improved normalize function (minimal break to rest of logic)
function normalizePhone(input, defaultCountry = "91") {
  if (input === undefined || input === null || input === "") return null;
  let s = String(input).trim();

  // convert fullwidth plus to ascii plus
  s = s.replace(/\uFF0B/g, "+");

  // If it starts with +, keep leading + and strip all non-digits after it
  if (s.startsWith("+")) {
    s = "+" + s.slice(1).replace(/\D/g, "");
  } else {
    // strip non-digits entirely
    s = s.replace(/\D/g, "");
  }

  // remove leading zeros (local style)
  s = s.replace(/^\+?0+/, (m) => (m.startsWith("+") ? "+" : ""));

  // If still no plus, add default country assumptions:
  if (!s.startsWith("+")) {
    if (s.length === 12 && s.startsWith(defaultCountry)) {
      s = `+${s}`;
    } else if (s.length === 10) {
      s = `+${defaultCountry}${s}`;
    } else {
      // best effort fallback
      s = `+${defaultCountry}${s}`;
    }
  }

  // Final E.164 sanity check: + followed by 6-15 digits
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

    console.log("📤 Sending PDF to (normalized):", userNumber);

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

    // Prepare payload for user
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

    // Send to user
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

    // Send to admin + subadmins (filter falsy numbers)
    const extraRecipients = [adminNumberFixed, ...subadminNumbersFixed].filter(Boolean);

    if (extraRecipients.length > 0) {
      const sendPromises = extraRecipients.map(number => {
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
        return axios.post(
          `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        ).then(res => ({ status: 'fulfilled', number, res: res.data }))
         .catch(err => ({ status: 'rejected', number, err: err.response?.data || err.message }));
      });

      const results = await Promise.allSettled(sendPromises);
      results.forEach(r => {
        if (r.status === 'fulfilled') {
          console.log("✅ Admin send result:", r.value);
        } else {
          console.warn("⚠️ Admin send rejected:", r.reason || r);
        }
      });
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
    const errorMessage = err.response?.data?.error?.message || err.message || String(err);
    console.error("❌ Error sending PDF:", errorMessage);

    // Notify admin of failure (safe: wrapped in try/catch)
    if (adminNumber) {
      try {
        const adminNormalized = normalizePhone(adminNumber);
        if (adminNormalized) {
          const failMsg = `❌ *PDF failed to send*\nTo: ${to}\nReason: ${errorMessage}\n\n📝 ${originalMessage}`;
          const notifyPayload = {
            messaging_product: "whatsapp",
            to: adminNormalized,
            text: { body: failMsg },
          };
          console.log("➡️ Notifying admin of failure:", JSON.stringify(notifyPayload));
          // fire-and-forget but await to ensure we try to notify
          await axios.post(
            `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
            notifyPayload,
            {
              headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );
        } else {
          console.warn("⚠️ Admin number invalid, cannot notify:", adminNumber);
        }
      } catch (notifyErr) {
        console.error("⚠️ Failed to notify admin about the error:", notifyErr.response?.data || notifyErr.message || notifyErr);
      }
    }
  }
}

module.exports = sendPDF;
