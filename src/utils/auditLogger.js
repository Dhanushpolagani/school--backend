const pool = require("../config/db");

/**
 * Record an audit log entry safely without blocking or throwing errors
 * to the main request flow.
 */
async function logAudit(req, {
  action,
  entityType,
  entityId = null,
  details = {},
  status = "SUCCESS",
}) {
  try {
    const tenantId = req?.user?.tenantId || req?.tenantId || null;
    if (!tenantId) return;

    const userId = req?.user?.id ? Number(req.user.id) : null;
    const userRole = Array.isArray(req?.user?.roles)
      ? req.user.roles.join(", ")
      : req?.user?.role || null;
    const userEmail = req?.user?.email || null;

    const ipAddress =
      req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req?.socket?.remoteAddress ||
      req?.ip ||
      null;

    const userAgent = req?.headers?.["user-agent"] || null;

    await pool.query(
      `INSERT INTO audit_logs (
         tenant_id,
         user_id,
         user_email,
         user_role,
         action,
         entity_type,
         entity_id,
         details,
         ip_address,
         user_agent,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        userId,
        userEmail,
        userRole,
        action,
        entityType,
        entityId ? String(entityId) : null,
        JSON.stringify(details || {}),
        ipAddress,
        userAgent,
        status,
      ]
    );
  } catch (error) {
    console.error("Audit log error:", error.message);
  }
}

module.exports = { logAudit };
