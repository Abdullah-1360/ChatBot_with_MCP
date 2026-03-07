/**
 * Phone Number Normalization Utility
 * Handles different phone number formats for Pakistan
 */

/**
 * Normalize phone number by removing non-digits and handling prefixes
 * @param {string|number} phoneNum - Phone number to normalize
 * @returns {string} Normalized phone number (digits only)
 * 
 * Examples:
 * - "923001234567" -> "923001234567"
 * - "+92 300 1234567" -> "923001234567"
 * - "0300-1234567" -> "3001234567"
 * - "3001234567" -> "3001234567"
 */
function normalizePhone(phoneNum) {
  if (!phoneNum) return '';
  
  // Remove all non-digit characters
  let normalized = phoneNum.toString().replace(/\D/g, '');
  
  // Handle different formats:
  // If starts with 0 (local format), remove it
  // This converts 03001234567 -> 3001234567
  if (normalized.startsWith('0') && !normalized.startsWith('00')) {
    normalized = normalized.substring(1);
  }
  
  // If starts with 92 (country code), keep as is
  // This keeps 923001234567 as 923001234567
  
  return normalized;
}

/**
 * Compare two phone numbers with multiple matching strategies
 * @param {string} phone1 - First phone number
 * @param {string} phone2 - Second phone number
 * @returns {boolean} True if phones match
 */
function phonesMatch(phone1, phone2) {
  const normalized1 = normalizePhone(phone1);
  const normalized2 = normalizePhone(phone2);
  
  // Strategy 1: Exact match
  if (normalized1 === normalized2) {
    return true;
  }
  
  // Strategy 2: One contains the other (handles partial matches)
  if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
    return true;
  }
  
  // Strategy 3: Both end with same last 10 digits (handles country code variations)
  // This handles cases like:
  // - 923001234567 vs 3001234567
  // - 03001234567 vs 923001234567
  const last10_1 = normalized1.slice(-10);
  const last10_2 = normalized2.slice(-10);
  
  if (last10_1.length >= 10 && last10_2.length >= 10 && last10_1 === last10_2) {
    return true;
  }
  
  return false;
}

/**
 * Mask phone number for display (show first 4 and last 3 digits)
 * @param {string|number} phoneNum - Phone number to mask
 * @returns {string} Masked phone number
 */
function maskPhone(phoneNum) {
  if (!phoneNum) return 'registered number';
  
  const phoneStr = phoneNum.toString();
  if (phoneStr.length <= 7) {
    return phoneStr.substring(0, 2) + '***';
  }
  
  return phoneStr.substring(0, 4) + '***' + phoneStr.slice(-3);
}

module.exports = {
  normalizePhone,
  phonesMatch,
  maskPhone
};
