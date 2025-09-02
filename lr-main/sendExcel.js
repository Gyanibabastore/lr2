// sendExcel.js
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const cron = require('node-cron');

async function sendExcel(to, filePath, caption = '📊 *Monthly Excel Log*') {
  const adminNumber = process.env.ADMIN_NUMBER;

  try {
    console.log("📤 Sending Excel to:", to);

    // 📁 Rename with date for clarity
    const fileName = `Rudransh_Trading_Log_${new Date().toISOString().split('T')[0]}.xlsx`;
    const renamedPath = path.join(__dirname, 'temp', fileName);

    // Ensure temp folder exists
    fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
    fs.copyFileSync(filePath, renamedPath);

    // Upload to WhatsApp
    const form = new FormData();
    form.append('file', fs.createReadStream(renamedPath));
    form.append('type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
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

    // Send to main recipient
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          id: mediaId,
          caption,
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

    console.log("✅ Excel sent to:", to);

    // Notify admin if sending to someone else
    if (adminNumber && adminNumber !== to) {
      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: adminNumber,
          type: "document",
          document: {
            id: mediaId,
            caption: `📊 *Excel Log Sent*\nTo: ${to}\n\n${caption}`,
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
    }

    // 🧹 Cleanup temp file
    fs.unlinkSync(renamedPath);

  } catch (err) {
    const errorMessage = err.response?.data?.error?.message || err.message;
    console.error("❌ Error sending Excel:", errorMessage);

    if (adminNumber) {
      const failMsg = `❌ *Excel failed to send*\nTo: ${to}\nReason: ${errorMessage}`;
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
    }
  }
}

// 📅 Schedule for last day of every month at 23:59 IST
cron.schedule('59 23 28-31 * *', async () => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  // Check if it's the last day of month
  if (tomorrow.getDate() === 1) {
    console.log("📅 Last day of month — sending monthly Excel log...");

    const filePath = path.join(__dirname, 'logs', 'monthly_log.xlsx'); // Change to your file path
    await sendExcel(process.env.ADMIN_NUMBER, filePath, '📊 *Monthly Excel Log*');
  }
}, {
  timezone: "Asia/Kolkata"
});

module.exports = sendExcel;
