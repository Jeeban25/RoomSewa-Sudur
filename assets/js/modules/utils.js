/**
 * Formats a given number into Nepalese Rupee (NPR) currency string.
 * @param {number} amount
 * @returns {string}
 */
export function formatCurrency(amount) {
  return `Rs. ${amount.toLocaleString('en-IN')}`;
}