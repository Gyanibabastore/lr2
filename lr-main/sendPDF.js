const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const subadminPath = path.join(__dirname, './subadmin.json');

// ✅ Normalize numbers to E.164 (+91 format for India)
function normalizePhone(number) {
  if (!number) return null;

  // remove non-digits
  number = number.toString().replace(/\D/g, "");

  // If already 10 digit → assume India
  if (number.length === 10) {
    return `+91${number}`;
  }

  // If 12 digit starts with 91 → add +
  if (number.length === 12 && number.startsWith("91")) {
    return `+${number}`;
  }

  // If starts with + and length > 10 → valid
  if (number.startsWith("+") && number.length > 10) {
    return number;
  }

  // Else invalid
  console.error("❌ Invalid phone format:", number);
  return null;
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
  }

  try {
    // ✅ Normalize numbers before use
    const userNumber = normalizePhone(to);
    const adminNumberFixed = normalizePhone(adminNumber);
    const subadminNumbersFixed = subadminNumbers.map(normalizePhone).filter(Boolean);

    console.log("📤 Sending PDF to:", userNumber);

    const fileName = `${truckNumber || 'LR'}.pdf`;
    const tempDir = path.join(__dirname, 'temp');
    const renamedPath = path.join(tempDir, fileName);

    fs.mkdirSync(tempDir, { recursive: true });
    fs.copyFileSync(filePath, renamedPath);

    // Upload PDF to WhatsApp
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
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: userNumber,
        type: "document",
        document: {
          id: mediaId,
          caption: `\nDate: ${new Date().toLocaleDateString()}`,
          filename: fileName,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log("✅ PDF sent to user:", userNumber);

    // Send to admin + subadmins
    const extraRecipients = [adminNumberFixed, ...subadminNumbersFixed];

    for (const number of extraRecipients) {
      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: number,
          type: "document",
          document: {
            id: mediaId,
            caption: `📄 LR\nT: ${templateNumber || '-'}\nMobile: ${userNumber}\nDate: ${new Date().toLocaleDateString()}\n\n📝 ${originalMessage}`,
            filename: fileName,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log(`✅ PDF sent to admin/subadmin: ${number}`);
    }

    // Cleanup
    fs.unlinkSync(renamedPath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log("🗑 Deleted original generated PDF:", filePath);
    }

  } catch (err) {
    const errorMessage = err.response?.data?.error?.message || err.message;
    console.error("❌ Error sending PDF:", errorMessage);

    // Notify admin of failure
    if (adminNumber) {
      const failMsg = `❌ *PDF failed to send*\nTo: ${to}\nReason: ${errorMessage}\n\n📝 ${originalMessage}`;
      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: normalizePhone(adminNumber),
          text: { body: failMsg },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );
    }
  }
}

module.exports = sendPDF;
