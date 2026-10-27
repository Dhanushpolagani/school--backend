/**
 * Helper to parse pagination parameters
 */
function getPagination(query, defaultLimit = 20) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Format paginated response meta
 */
function paginationMeta(total, page, limit) {
  return {
    total: parseInt(total, 10) || 0,
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    totalPages: Math.ceil((parseInt(total, 10) || 0) / limit),
  };
}

module.exports = {
  getPagination,
  paginationMeta,
};
