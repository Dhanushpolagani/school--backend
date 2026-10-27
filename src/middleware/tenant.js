const { pool } = require("../config/db");

/**
 * resolveTenant — attaches req.tenantId from the authenticated user
 * For super_admin calls that target a specific tenant, reads from header.
 */
async function resolveTenant(req, res, next) {
  try {
    if (req.user?.role === "super_admin" || req.user?.roles?.includes("super_admin")) {
      req.tenantId = req.headers["x-tenant-id"] || req.user?.tenantId;
    } else {
      req.tenantId = req.user?.tenantId;
    }

    if (!req.tenantId) {
      return res.status(400).json({
        success: false,
        error: { message: "Tenant context missing" },
        message: "Tenant context missing",
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { resolveTenant };
