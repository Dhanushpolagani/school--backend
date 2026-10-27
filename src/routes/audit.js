const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();

router.use(authenticateToken);

function tenantIdOf(req) {
  return req.user?.tenantId;
}

function isPositiveId(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0;
}

function isAdmin(req) {
  const roles = req.user?.roles || [];
  return roles.includes("school_admin") || roles.includes("admin");
}

function requireTenant(req, res) {
  const tenantId = tenantIdOf(req);
  if (!tenantId) {
    res.status(401).json({
      success: false,
      message: "Tenant authentication required.",
    });
    return null;
  }
  return tenantId;
}

/* ==========================================================================
   AUDIT LOGS
   ========================================================================== */

// GET /api/audit-logs/stats or /api/audit/stats
// Statistics and aggregation on audit log activities
router.get(["/audit-logs/stats", "/stats"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const totalLogsRes = await pool.query(
      `SELECT
         COUNT(*) AS total_events,
         COUNT(*) FILTER (WHERE status = 'SUCCESS') AS success_count,
         COUNT(*) FILTER (WHERE status = 'FAILURE') AS failure_count,
         COUNT(*) FILTER (WHERE status = 'WARNING') AS warning_count,
         COUNT(*) FILTER (WHERE action = 'CREATE') AS create_count,
         COUNT(*) FILTER (WHERE action = 'UPDATE') AS update_count,
         COUNT(*) FILTER (WHERE action = 'DELETE') AS delete_count,
         COUNT(*) FILTER (WHERE action = 'STATUS_CHANGE') AS status_change_count
       FROM audit_logs
       WHERE tenant_id = $1`,
      [tenantId]
    );

    const byEntityRes = await pool.query(
      `SELECT
         entity_type,
         COUNT(*) AS count
       FROM audit_logs
       WHERE tenant_id = $1
       GROUP BY entity_type
       ORDER BY count DESC
       LIMIT 10`,
      [tenantId]
    );

    const dailyActivityRes = await pool.query(
      `SELECT
         created_at::date::text AS date,
         COUNT(*) AS count
       FROM audit_logs
       WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
       GROUP BY created_at::date
       ORDER BY date ASC`,
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        summary: totalLogsRes.rows[0],
        byEntity: byEntityRes.rows,
        dailyActivity: dailyActivityRes.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/audit-logs or /api/audit/logs or /api/audit
// List audit logs with multi-parameter filtering & pagination
router.get(["/audit-logs", "/logs", "/"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const {
      action,
      entityType,
      status,
      userId,
      startDate,
      endDate,
      search,
      page = 1,
      limit = 25,
    } = req.query;

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const offset = (parsedPage - 1) * parsedLimit;

    const conditions = ["tenant_id = $1"];
    const params = [tenantId];
    let paramIndex = 2;

    if (action && typeof action === "string") {
      conditions.push(`action = $${paramIndex}`);
      params.push(action.toUpperCase());
      paramIndex++;
    }

    if (entityType && typeof entityType === "string") {
      conditions.push(`entity_type = $${paramIndex}`);
      params.push(entityType);
      paramIndex++;
    }

    if (status && typeof status === "string") {
      conditions.push(`status = $${paramIndex}`);
      params.push(status.toUpperCase());
      paramIndex++;
    }

    if (userId && isPositiveId(userId)) {
      conditions.push(`user_id = $${paramIndex}`);
      params.push(userId);
      paramIndex++;
    }

    if (startDate) {
      conditions.push(`created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    if (search && typeof search === "string" && search.trim()) {
      conditions.push(`(
        user_email ILIKE $${paramIndex} OR
        entity_id ILIKE $${paramIndex} OR
        details::text ILIKE $${paramIndex}
      )`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    const whereClause = conditions.join(" AND ");

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM audit_logs WHERE ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    const query = `
      SELECT *
      FROM audit_logs
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(parsedLimit, offset);
    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / parsedLimit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/audit-logs/export or /api/audit/export
router.get(["/audit-logs/export", "/export"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [tenantId]
    );
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/audit-logs/:id or /api/audit/logs/:id
// Get single audit log entry
router.get(["/audit-logs/:id", "/logs/:id"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM audit_logs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Audit log entry not found." });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   SECURITY REVIEW & HEALTH ASSESSMENT
   ========================================================================== */

// GET /api/security/review
// Complete security health review of the tenant and system
router.get("/security/review", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    // 1. User & Account Security Metrics
    const usersMetrics = await pool.query(
      `SELECT
         COUNT(*) AS total_users,
         COUNT(*) FILTER (WHERE is_active = true) AS active_users,
         COUNT(*) FILTER (WHERE is_active = false) AS inactive_users,
         COUNT(DISTINCT u.id) FILTER (WHERE r.name = 'school_admin') AS admin_count
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.tenant_id = $1`,
      [tenantId]
    );

    // 2. Active Session Security
    const sessionsMetrics = await pool.query(
      `SELECT
         COUNT(*) AS total_active_sessions,
         COUNT(*) FILTER (WHERE expires_at > NOW()) AS valid_sessions,
         COUNT(*) FILTER (WHERE expires_at <= NOW()) AS expired_sessions
       FROM refresh_sessions
       WHERE tenant_id = $1`,
      [tenantId]
    );

    // 3. Security Events from Audit Logs
    const securityEvents = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'FAILURE') AS failed_actions_last_30d,
         COUNT(*) FILTER (WHERE status = 'WARNING') AS warning_actions_last_30d
       FROM audit_logs
       WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
      [tenantId]
    );

    // 4. System Environment Checks
    const jwtConfigured = Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32);
    const isProduction = process.env.NODE_ENV === "production";
    const corsConfigured = Boolean(process.env.CORS_ORIGIN);

    // Security recommendations list
    const recommendations = [];
    if (!jwtConfigured) {
      recommendations.push({
        severity: "CRITICAL",
        message: "JWT_SECRET should be a strong random secret with at least 32 characters.",
      });
    }
    if (!isProduction) {
      recommendations.push({
        severity: "INFO",
        message: "Application is running in development mode. Ensure NODE_ENV=production in production.",
      });
    }
    if (parseInt(usersMetrics.rows[0].admin_count, 10) > 5) {
      recommendations.push({
        severity: "WARNING",
        message: "More than 5 administrator accounts detected. Review administrator privileges regularly.",
      });
    }

    res.json({
      success: true,
      data: {
        securityScore: recommendations.some((r) => r.severity === "CRITICAL") ? 70 : 95,
        accounts: usersMetrics.rows[0],
        sessions: sessionsMetrics.rows[0],
        threatsAndFailures: securityEvents.rows[0],
        configuration: {
          jwtSecretLength: process.env.JWT_SECRET?.length || 0,
          jwtValid: jwtConfigured,
          environment: process.env.NODE_ENV || "development",
          corsOrigin: process.env.CORS_ORIGIN || "default",
          rateLimitEnabled: true,
          helmetProtectionEnabled: true,
        },
        recommendations,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/security/sessions
// List active refresh sessions
router.get("/security/sessions", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT
         rs.id,
         rs.user_id,
         u.email AS user_email,
         u.full_name,
         rs.created_at,
         rs.expires_at,
         (rs.expires_at > NOW()) AS is_active
       FROM refresh_sessions rs
       JOIN users u ON u.tenant_id = rs.tenant_id AND u.id = rs.user_id
       WHERE rs.tenant_id = $1
       ORDER BY rs.created_at DESC
       LIMIT 50`,
      [tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/security/sessions/:id
// Revoke a specific session
router.delete("/security/sessions/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM refresh_sessions WHERE tenant_id = $1 AND id = $2 RETURNING user_id`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Session not found." });
    }

    await logAudit(req, {
      action: "SECURITY_EVENT",
      entityType: "session",
      entityId: id,
      details: { action: "revoke_session", revokedUserId: result.rows[0].user_id },
    });

    res.json({
      success: true,
      message: "Session revoked successfully.",
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/security/revoke-user-sessions
// Revoke all sessions for a user
router.post("/security/revoke-user-sessions", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { userId } = req.body;
  if (!isPositiveId(userId)) {
    return res.status(400).json({ success: false, message: "Valid userId is required." });
  }

  try {
    const result = await pool.query(
      `DELETE FROM refresh_sessions WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId]
    );

    await logAudit(req, {
      action: "SECURITY_EVENT",
      entityType: "user_sessions",
      entityId: userId,
      details: { action: "revoke_all_user_sessions", sessionsRevoked: result.rowCount },
    });

    res.json({
      success: true,
      message: `Revoked ${result.rowCount} session(s) for user.`,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
