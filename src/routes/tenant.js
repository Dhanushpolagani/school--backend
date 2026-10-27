const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();

router.use(authenticateToken);

function tenantIdOf(req) {
  return req.user?.tenantId;
}

function isAdmin(req) {
  const roles = req.user?.roles || [];
  return roles.includes("school_admin") || roles.includes("admin");
}

// GET /api/tenant or /api/tenant/current
// Get the current tenant / school details
router.get(["/", "/current"], async (req, res, next) => {
  const tenantId = tenantIdOf(req);
  if (!tenantId) {
    return res.status(401).json({
      success: false,
      message: "Tenant authentication required.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, slug, email, phone, address, status, created_at, updated_at
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Tenant not found.",
      });
    }

    return res.json({
      success: true,
      tenant: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/tenant or /api/tenant/current
// Update the current school profile
router.put(["/", "/current"], async (req, res, next) => {
  const tenantId = tenantIdOf(req);
  if (!tenantId) {
    return res.status(401).json({
      success: false,
      message: "Tenant authentication required.",
    });
  }

  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Forbidden: Administrator privileges required.",
    });
  }

  const { name, email, phone, address } = req.body || {};

  try {
    const existing = await pool.query("SELECT * FROM tenants WHERE id = $1", [tenantId]);
    if (existing.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Tenant not found.",
      });
    }

    const updatedName = typeof name === "string" && name.trim() ? name.trim() : existing.rows[0].name;
    const updatedEmail = email !== undefined ? email : existing.rows[0].email;
    const updatedPhone = phone !== undefined ? phone : existing.rows[0].phone;
    const updatedAddress = address !== undefined ? address : existing.rows[0].address;

    const result = await pool.query(
      `UPDATE tenants
       SET name = $1, email = $2, phone = $3, address = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING id, name, slug, email, phone, address, status, created_at, updated_at`,
      [updatedName, updatedEmail, updatedPhone, updatedAddress, tenantId]
    );

    await logAudit(req, {
      action: "UPDATE",
      entity: "TENANT",
      entityId: String(tenantId),
      details: { updatedFields: { name: updatedName, email: updatedEmail, phone: updatedPhone, address: updatedAddress } },
    });

    return res.json({
      success: true,
      message: "Tenant updated successfully.",
      tenant: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/tenant/:id
// Get a specific tenant (Admin only)
router.get("/:id", async (req, res, next) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ success: false, message: "Invalid tenant ID." });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, slug, email, phone, address, status, created_at, updated_at
       FROM tenants
       WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Tenant not found." });
    }

    return res.json({
      success: true,
      tenant: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
