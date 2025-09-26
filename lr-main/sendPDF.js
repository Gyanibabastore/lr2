// sendPDF.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { normalizePhone } = require('./utils/phone');

const subadminPath = path.join(__dirname, './subadmin.json');

async function sendPDF(to, filePath, templateNumber = null, originalMessage = '', truckNumber = null) {
  const phoneId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const adminRaw = process.env.ADMIN_NUMBER;

  if (!phoneId || !token) {
    console.error('❌ PHONE_NUMBER_ID or WHATSAPP_TOKEN not set in env');
    throw new Error('WhatsApp credentials missing');
  }

  // load subadmins if present
  let subadminNumbers = [];
  try {
    if (fs.existsSync(subadminPath)) {
      const raw = fs.readFileSync(subadminPath, 'utf8');
      subadminNumbers = JSON.parse(raw);
      if (!Array.isArray(subadminNumbers)) subadminNumbers = [];
    }
  } catch (e) {
    console.error('❌ Could not read subadmin.json:', e.message);
  }

  // Prepare recipients
  const userNumber = normalizePhone(to);
  const adminNumber = normalizePhone(adminRaw);
  const subadmins = Array.isArray(subadminNumbers) ? subadminNumbers.map(normalizePhone).filter(Boolean) : [];

  if (!userNumber) {
    console.error('❌ Invalid user phone:', to);
    throw new Error('Invalid recipient phone number');
  }

  const fileName = `${truckNumber || 'LR'}.pdf`;
  const tempDir = path.join(__dirname, 'temp');
  const renamedPath = path.join(tempDir, fileName);

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.copyFileSync(filePath, renamedPath);

    // Upload media
    const form = new FormData();
    form.append('file', fs.createReadStream(renamedPath));
    form.append('type', 'application/pdf');
    form.append('messaging_product', 'whatsapp');

    const uploadUrl = `https://graph.facebook.com/v19.0/${phoneId}/media`;

    const uploadRes = await axios.post(uploadUrl, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const mediaId = uploadRes?.data?.id;
    if (!mediaId) throw new Error('Media upload failed');

    console.log('📎 Media uploaded. ID:', mediaId);

    // Send document to user
    const sendUrl = `https://graph.facebook.com/v19.0/${phoneId}/messages`;
    const dateStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    const userPayload = {
      messaging_product: "whatsapp",
      to: userNumber,
      type: "document",
      document: {
        id: mediaId,
        caption: `Date: ${dateStr}`,
        filename: fileName,
      },
    };

    await axios.post(sendUrl, userPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('✅ PDF sent to user:', userNumber);

    // Send to admin + subadmins (if valid)
    const extras = [adminNumber, ...subadmins].filter(Boolean);
    for (const num of extras) {
      try {
        const captionLines = [
          '📄 LR',
          `T: ${templateNumber || '-'}`,
          `Mobile: ${userNumber}`,
          `Date: ${dateStr}`,
          '',
          `📝 ${originalMessage || '-'}`,
        ];
        const adminPayload = {
          messaging_product: "whatsapp",
          to: num,
          type: "document",
          document: {
            id: mediaId,
            caption: captionLines.join('\n'),
            filename: fileName,
          },
        };
        await axios.post(sendUrl, adminPayload, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        console.log('✅ PDF sent to admin/subadmin:', num);
      } catch (e) {
        console.error('❌ Failed sending to admin/subadmin', num, e?.response?.data || e.message);
      }
    }

    // Cleanup
    try { fs.unlinkSync(renamedPath); } catch (e) {}
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}

  } catch (err) {
    const errorMessage = err?.response?.data?.error?.message || err.message || String(err);
    console.error('❌ Error in sendPDF:', errorMessage);

    // Notify admin if possible
    const adminToNotify = adminNumber;
    if (adminToNotify) {
      try {
        const failMsg = `❌ *PDF failed to send*\nTo: ${to}\nReason: ${errorMessage}\n\n📝 ${originalMessage || '-'}`;
        await axios.post(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
          messaging_product: "whatsapp",
          to: adminToNotify,
          text: { body: failMsg },
        }, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
      } catch (e) {
        console.error('❌ Failed to notify admin about failure', e?.response?.data || e.message);
      }
    }

    throw err;
  }
}

module.exports = sendPDF;
