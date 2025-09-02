const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'generatedLogs.xlsx');

// 🧹 Function to delete sheets older than 2 months
function deleteOldSheets(workbook) {
  const now = new Date();

  workbook.SheetNames = workbook.SheetNames.filter(sheetName => {
    const sheetDate = new Date(sheetName + " 1"); // e.g., "July 2025 1"
    const monthsDiff =
      (now.getFullYear() - sheetDate.getFullYear()) * 12 +
      (now.getMonth() - sheetDate.getMonth());

    if (monthsDiff > 2) {
      console.log(`🗑️ Deleting old sheet: ${sheetName}`);
      delete workbook.Sheets[sheetName]; // Remove sheet data
      return false; // Remove sheet name
    }
    return true; // Keep this sheet
  });
}

// 📥 Main logging function
function logToExcel(data) {
  let workbook;

  try {
    // 🗓️ Use current or provided date
    const entryDate = data.date ? new Date(data.date) : new Date();
    const monthYear = entryDate.toLocaleString('default', { month: 'long', year: 'numeric' }); // e.g., "July 2025"

    console.log(`📅 Logging data to sheet: ${monthYear}`);

    // 📘 Load workbook or create new
    if (fs.existsSync(filePath)) {
      console.log('📂 Existing Excel file found, loading...');
      workbook = XLSX.readFile(filePath);
    } else {
      console.log('🆕 Excel file not found, creating new workbook...');
      workbook = XLSX.utils.book_new();
    }

    let worksheet;
    const existingSheet = workbook.Sheets[monthYear];

    // 📊 Extract existing data
    const existingData = existingSheet
      ? XLSX.utils.sheet_to_json(existingSheet, { defval: '' })
      : [];

    if (!existingSheet) {
      console.log(`📝 Creating new sheet for ${monthYear}`);
    }

    // ➕ Add new entry
    existingData.push(data);
    console.log(`➕ Appending data:`, data);

    // 🔄 Update worksheet
    worksheet = XLSX.utils.json_to_sheet(existingData);
    workbook.Sheets[monthYear] = worksheet;

    // 🧾 Add to SheetNames if needed
    if (!workbook.SheetNames.includes(monthYear)) {
      workbook.SheetNames.push(monthYear);
    }

    // 🧹 Delete sheets older than 2 months
    deleteOldSheets(workbook);

    // 💾 Save file
    XLSX.writeFile(workbook, filePath);
    console.log(`✅ Excel log updated successfully: ${filePath}`);
  } catch (err) {
    console.error('❌ Error while logging to Excel:', err.message);
  }
}

module.exports = logToExcel;
