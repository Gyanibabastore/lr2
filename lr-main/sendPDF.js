// sendPDF.js — safe send: only send PDF when LR details complete; otherwise notify admin & subadmins
// Replace your existing sendPDF module with this file (copy-paste).

const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const { normalizePhone } = require('./utils/phone');
const { extractDetails } = require('./utils/lrExtractor'); // assumes your LR extractor exports this

const subadminPath = path.join(__dirname, './subadmin.json');

async function sendTextMessage(phoneId, token, toNumber, textBody) {
  // helper: send plain text WhatsApp message via Graph API
  try {
    const payload = {
      messaging_product: 'whatsapp',
      to: toNumber,
      text: { body: textBody },
    };
    await axios.post(`https://graph.facebook.com/v19.0/${phoneId}/messages`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`✅ Text message sent to ${toNumber}`);
  } catch (e) {
    console.error('❌ Failed to send text message to', toNumber, e?.response?.data || e.message || e);
  }
}

async function sendPDF(to, filePath, templateNumber = null, originalMessage = '', truckNumber = null) {
  const phoneId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const adminNumberRaw = process.env.ADMIN_NUMBER;

  if (!phoneId || !token) {
    console.error('❌ PHONE_NUMBER_ID or WHATSAPP_TOKEN not set in env');
    throw new Error('WhatsApp credentials missing');
  }

  // load subadmins
  let subadminNumbers = [];
  try {
    if (fs.existsSync(subadminPath)) {
      const raw = fs.readFileSync(subadminPath, 'utf8');
      subadminNumbers = JSON.parse(raw);
      if (!Array.isArray(subadminNumbers)) subadminNumbers = [];
    }
  } catch (e) {
    console.error('❌ Could not read subadmin.json:', e.message);
    subadminNumbers = [];
  }

  // Normalize recipients
  const userNumber = normalizePhone(to);
  const adminNumber = normalizePhone(adminNumberRaw);
  const subadmins = Array.isArray(subadminNumbers)
    ? subadminNumbers.map(normalizePhone).filter(Boolean)
    : [];

  if (!userNumber) {
    console.error('❌ Invalid user phone:', to);
    throw new Error('Invalid recipient phone number');
  }

  console.log('[sendPDF] Incoming request — to:', userNumber, 'template:', templateNumber);
  console.log('[sendPDF] Original message snippet:', String(originalMessage || '').slice(0, 400));

  // --- 1) Validate LR details BEFORE sending PDF ---
  try {
    console.log('[sendPDF] Extracting LR details from message before sending PDF...');
    const details = await extractDetails(originalMessage || '');

    console.log('[sendPDF] LR extract result:', details);

    const hasMandatory =
      details &&
      typeof details === 'object' &&
      details.truckNumber &&
      details.to &&
      details.weight &&
      details.description;

    if (!hasMandatory) {
      // Prepare admin notification (do not send PDF)
      const notifLines = [
        '⚠️ LR Parser Incomplete — PDF NOT SENT',
        `Mobile: ${userNumber}`,
        `Template: ${templateNumber || '-'}`,
        `Original message:`,
        `${originalMessage || '-'}`,
        '',
        'Parsed fields (best-effort):',
        `truckNumber: ${details?.truckNumber || ''}`,
        `from: ${details?.from || ''}`,
        `to: ${details?.to || ''}`,
        `weight: ${details?.weight || ''}`,
        `description: ${details?.description || ''}`,
        `name: ${details?.name || ''}`,
        '',
        'Action: Please review the message and send PDF manually once details are available.'
      ];

      const adminText = notifLines.join('\n');

      console.warn('[sendPDF] Mandatory LR fields missing — skipping PDF upload & send. Notifying admin/subadmins...');

      // notify admin
      if (adminNumber) {
        await sendTextMessage(phoneId, token, adminNumber, adminText);
      } else {
        console.warn('[sendPDF] ADMIN_NUMBER not configured — cannot notify primary admin.');
      }

      // notify subadmins
      for (const sa of subadmins) {
        try {
          await sendTextMessage(phoneId, token, sa, adminText);
        } catch (e) {
          console.error('[sendPDF] Failed notifying subadmin', sa, e?.response?.data || e.message || e);
        }
      }

      // Also optionally notify the user that PDF is not being sent due to missing details (commented out — enable if desired)
      // await sendTextMessage(phoneId, token, userNumber, 'Your LR could not be processed automatically. Admin has been notified.');

      // return early — PDF not sent
      return {
        sent: false,
        reason: 'missing_lr_fields',
        details,
      };
    }

  } catch (e) {
    console.error('[sendPDF] Error while extracting LR details — aborting PDF send. Error:', e?.message || e);
    // attempt to notify admin about extractor failure
    const errText = `❌ LR extraction error while processing message from ${userNumber}.\nError: ${e?.message || e}\nOriginal message:\n${originalMessage || '-'}`;
    if (adminNumber) {
      await sendTextMessage(phoneId, token, adminNumber, errText);
    }
    for (const sa of subadmins) {
      await sendTextMessage(phoneId, token, sa, errText);
    }
    return {
      sent: false,
      reason: 'extractor_error',
      error: e?.message || String(e),
    };
  }

  // --- 2) If we are here, LR mandatory fields exist — proceed to upload & send PDF ---
  const fileName = `${truckNumber || 'LR'}.pdf`;
  const tempDir = path.join(__dirname, 'temp');
  const renamedPath = path.join(tempDir, fileName);

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.copyFileSync(filePath, renamedPath);

    // Upload PDF to WhatsApp
    const form = new FormData();
    form.append('file', fs.createReadStream(renamedPath));
    form.append('type', 'application/pdf');
    form.append('messaging_product', 'whatsapp');

    const uploadUrl = `https://graph.facebook.com/v19.0/${phoneId}/media`;
    console.log('[sendPDF] Uploading media to WhatsApp Graph API:', uploadUrl);
    const uploadRes = await axios.post(uploadUrl, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const mediaId = uploadRes?.data?.id;
    if (!mediaId) throw new Error('Media upload failed: no media id returned');
    console.log('📎 Media uploaded. ID:', mediaId);

    // Send to user
    const sendUrl = `https://graph.facebook.com/v19.0/${phoneId}/messages`;
    const dateStr = new Date().toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
    });

    const userPayload = {
      messaging_product: 'whatsapp',
      to: userNumber,
      type: 'document',
      document: {
        id: mediaId,
        caption: `Date: ${dateStr}`,
        filename: fileName,
      },
    };

    console.log('[sendPDF] Sending PDF to user:', userNumber);
    await axios.post(sendUrl, userPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('✅ PDF sent to user:', userNumber);

    // Send to admin + subadmins
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
          messaging_product: 'whatsapp',
          to: num,
          type: 'document',
          document: {
            id: mediaId,
            caption: captionLines.join('\n'),
            filename: fileName,
          },
        };

        console.log('[sendPDF] Sending PDF to admin/subadmin:', num);
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
    try {
      fs.unlinkSync(renamedPath);
    } catch (e) {}
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}

    return { sent: true, mediaId, fileName };
  } catch (err) {
    const errorMessage = err?.response?.data?.error?.message || err.message || String(err);
    console.error('❌ Error sending PDF:', errorMessage);

    // Notify admin of failure (if admin configured)
    const failMsg = `❌ *PDF failed to send*\nTo: ${userNumber}\nReason: ${errorMessage}\n\n📝 ${originalMessage || '-'}`;
    if (adminNumber) {
      try {
        await sendTextMessage(phoneId, token, adminNumber, failMsg);
      } catch (e) {
        console.error('❌ Failed to notify admin about failure', e?.response?.data || e.message);
      }
    }

    // notify subadmins
    for (const sa of subadmins) {
      try {
        await sendTextMessage(phoneId, token, sa, failMsg);
      } catch (e) {
        console.error('❌ Failed to notify subadmin about failure', sa, e?.response?.data || e.message);
      }
    }

    throw err;
  }
}

module.exports = sendPDF;
