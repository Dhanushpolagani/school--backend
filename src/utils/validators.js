/**
 * Common input validation helpers
 */
function isValidId(value) {
  if (value === null || value === undefined) return false;
  const str = String(value).trim();
  // Support both numeric IDs and UUIDs
  return /^[1-9]\d*$/.test(str) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function isValidEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

module.exports = {
  isValidId,
  isValidDate,
  isValidEmail,
};
