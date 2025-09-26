// utils/phone.js
// Robust E.164 normalizer (India-friendly)
// Returns null for invalid / empty values, otherwise returns string like "+911234567890"

function normalizePhone(number) {
  if (!number && number !== 0) return null;
  let raw = String(number).trim();

  // If it already starts with '+', keep it but remove any non-digits after +
  if (raw.startsWith('+')) {
    const digits = raw.slice(1).replace(/\D/g, '');
    if (digits.length === 0) return null;
    return '+' + digits;
  }

  // Remove non-digit characters
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // If 10 digits assume India mobile
  if (digits.length === 10) return '+91' + digits;

  // If 12 digits and starts with 91
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;

  // If already has country code-like digits (11-15 digits) — prefix with +
  if (digits.length >= 11 && digits.length <= 15) return '+' + digits;

  // Fallback: not recognized
  return null;
}

module.exports = { normalizePhone };
