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
   ANNOUNCEMENTS (Circulars, School Notices, Events)
   ========================================================================== */

// GET /api/announcements or /api/notices
// List announcements relevant to the logged-in user
router.get(["/announcements", "/notices"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const { category, priority, status = "published" } = req.query;
    const userRoles = req.user?.roles || [];

    const conditions = ["tenant_id = $1"];
    const params = [tenantId];
    let paramIndex = 2;

    if (status && typeof status === "string") {
      conditions.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (category && typeof category === "string") {
      conditions.push(`category = $${paramIndex}`);
      params.push(category);
      paramIndex++;
    }

    if (priority && typeof priority === "string") {
      conditions.push(`priority = $${paramIndex}`);
      params.push(priority);
      paramIndex++;
    }

    // Role-based target audience filtering (admins see all)
    const isAdmin = userRoles.includes("school_admin") || userRoles.includes("admin");
    if (!isAdmin) {
      const audienceFilters = ["'all'"];
      if (userRoles.includes("teacher")) audienceFilters.push("'teachers'", "'staff'");
      if (userRoles.includes("student")) audienceFilters.push("'students'");
      if (userRoles.includes("parent")) audienceFilters.push("'parents'");
      if (userRoles.includes("accountant")) audienceFilters.push("'staff'");

      conditions.push(`target_audience IN (${audienceFilters.join(", ")})`);
    }

    const query = `
      SELECT *
      FROM announcements
      WHERE ${conditions.join(" AND ")}
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          ELSE 4
        END,
        published_at DESC
    `;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/announcements/:id or /api/notices/:id
// Get a single announcement
router.get(["/announcements/:id", "/notices/:id"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  if (!isPositiveId(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid announcement ID format.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM announcements WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found.",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/announcements or /api/notices
// Create an announcement (admin/staff)
router.post(["/announcements", "/notices"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const {
    title,
    content,
    category = "general",
    targetAudience = "all",
    targetClassId,
    priority = "medium",
    attachmentUrl,
    expiresAt,
  } = req.body;

  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({
      success: false,
      message: "Announcement title is required.",
    });
  }

  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({
      success: false,
      message: "Announcement content is required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO announcements (
         tenant_id,
         title,
         content,
         category,
         target_audience,
         target_class_id,
         priority,
         attachment_url,
         expires_at,
         status,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', $10)
       RETURNING *`,
      [
        tenantId,
        title.trim(),
        content.trim(),
        category,
        targetAudience,
        targetClassId || null,
        priority,
        attachmentUrl?.trim() || null,
        expiresAt || null,
        req.user?.id ? Number(req.user.id) : null,
      ]
    );

    await logAudit(req, {
      action: "CREATE",
      entityType: "announcement",
      entityId: result.rows[0].id,
      details: { title, targetAudience, priority },
    });

    res.status(201).json({
      success: true,
      message: "Announcement published successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/announcements/:id
// PUT /api/announcements/:id or /api/notices/:id
// Update an announcement
router.put(["/announcements/:id", "/notices/:id"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const {
    title,
    content,
    category,
    targetAudience,
    priority,
    status,
    attachmentUrl,
    expiresAt,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE announcements
       SET
         title = COALESCE($1, title),
         content = COALESCE($2, content),
         category = COALESCE($3, category),
         target_audience = COALESCE($4, target_audience),
         priority = COALESCE($5, priority),
         status = COALESCE($6, status),
         attachment_url = COALESCE($7, attachment_url),
         expires_at = COALESCE($8, expires_at),
         updated_at = NOW()
       WHERE tenant_id = $9 AND id = $10
       RETURNING *`,
      [
        title?.trim() || null,
        content?.trim() || null,
        category || null,
        targetAudience || null,
        priority || null,
        status || null,
        attachmentUrl?.trim() || null,
        expiresAt || null,
        tenantId,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found.",
      });
    }

    await logAudit(req, {
      action: "UPDATE",
      entityType: "announcement",
      entityId: id,
      details: { changes: req.body },
    });

    res.json({
      success: true,
      message: "Announcement updated.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/announcements/:id or /api/notices/:id
// Delete an announcement
router.delete(["/announcements/:id", "/notices/:id"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM announcements WHERE tenant_id = $1 AND id = $2 RETURNING id, title`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found.",
      });
    }

    await logAudit(req, {
      action: "DELETE",
      entityType: "announcement",
      entityId: id,
      details: { deleted: result.rows[0] },
    });

    res.json({
      success: true,
      message: "Announcement deleted successfully.",
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   IN-APP NOTIFICATIONS (User-specific alerts & activity notifications)
   ========================================================================== */

// GET /api/notifications or /api/messages
// List notifications for current user with unread counter
router.get(["/notifications", "/messages"], async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const userId = Number(req.user.id);

    const unreadResult = await pool.query(
      `SELECT COUNT(*) FROM notifications
       WHERE tenant_id = $1 AND user_id = $2 AND is_read = false`,
      [tenantId, userId]
    );

    const listResult = await pool.query(
      `SELECT * FROM notifications
       WHERE tenant_id = $1 AND user_id = $2
       ORDER BY is_read ASC, created_at DESC
       LIMIT 50`,
      [tenantId, userId]
    );

    res.json({
      success: true,
      unreadCount: parseInt(unreadResult.rows[0].count, 10),
      data: listResult.rows,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/notifications/:id/read or PUT
router.all(["/notifications/:id/read", "/notifications/:id", "/messages/:id/read"], async (req, res, next) => {
  if (req.method !== "PATCH" && req.method !== "PUT") return next();
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE notifications
       SET is_read = true, read_at = NOW()
       WHERE tenant_id = $1 AND id = $2 AND user_id = $3
       RETURNING *`,
      [tenantId, id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Notification not found.",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST or PUT /api/notifications/read-all or /api/notifications/mark-all-read
router.all(["/notifications/mark-all-read", "/notifications/read-all"], async (req, res, next) => {
  if (req.method !== "POST" && req.method !== "PUT") return next();
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    await pool.query(
      `UPDATE notifications
       SET is_read = true, read_at = NOW()
       WHERE tenant_id = $1 AND user_id = $2 AND is_read = false`,
      [tenantId, req.user.id]
    );

    res.json({
      success: true,
      message: "All notifications marked as read.",
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/notifications/send
// Send notification to a specific user or broadcast to a role (admin/staff)
router.post("/notifications/send", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const {
    userId,
    targetRole,
    title,
    message,
    type = "info",
    category = "general",
    link,
  } = req.body;

  if (!title || !message) {
    return res.status(400).json({
      success: false,
      message: "Both title and message are required.",
    });
  }

  try {
    if (userId && isPositiveId(userId)) {
      // Direct notification
      const result = await pool.query(
        `INSERT INTO notifications (
           tenant_id,
           user_id,
           title,
           message,
           type,
           category,
           link
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [tenantId, userId, title.trim(), message.trim(), type, category, link?.trim() || null]
      );

      return res.status(201).json({
        success: true,
        message: "Notification sent to user.",
        data: result.rows[0],
      });
    }

    if (targetRole && typeof targetRole === "string") {
      // Broadcast to users having this role
      const usersRes = await pool.query(
        `SELECT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = $1 AND r.name = $2`,
        [tenantId, targetRole]
      );

      for (const u of usersRes.rows) {
        await pool.query(
          `INSERT INTO notifications (
             tenant_id,
             user_id,
             title,
             message,
             type,
             category,
             link
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, u.id, title.trim(), message.trim(), type, category, link?.trim() || null]
        );
      }

      return res.status(201).json({
        success: true,
        message: `Notification broadcasted to ${usersRes.rowCount} users with role '${targetRole}'.`,
      });
    }

    return res.status(400).json({
      success: false,
      message: "Either userId or targetRole must be specified.",
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
