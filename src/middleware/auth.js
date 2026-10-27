const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const ROLES = [
  "super_admin",
  "school_admin",
  "admin",
  "accountant",
  "hr_manager",
  "teacher",
  "librarian",
  "hostel_warden",
  "transport_manager",
  "parent",
  "student",
];

/**
 * verifyToken — validates JWT from HttpOnly cookie or Authorization Bearer header
 * Attaches req.user = { id, sub, email, role, roles, tenantId }
 */
function verifyToken(req, res, next) {
  let token = req.cookies?.access_token;

  if (!token && req.headers?.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.substring(7).trim();
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: { message: "Unauthorized — authentication required" },
      message: "Authentication required",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "REPLACE_WITH_A_LONG_RANDOM_SECRET_KEY"
    );

    const userId = decoded.id || decoded.sub;
    const tenantId = decoded.tenantId || decoded.tenant_id;
    const userRole = decoded.role || (Array.isArray(decoded.roles) ? decoded.roles[0] : "student");
    const roles = Array.isArray(decoded.roles)
      ? decoded.roles
      : [userRole].filter(Boolean);

    req.user = {
      ...decoded,
      id: String(userId),
      sub: String(userId),
      tenantId: String(tenantId),
      role: userRole,
      roles,
    };

    req.tenantId = String(tenantId);

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: { message: "Token expired or invalid" },
      message: "Invalid or expired authentication token",
    });
  }
}

/**
 * requireRole(...roles) — RBAC gate
 * Usage: router.get('/resource', verifyToken, requireRole('school_admin','teacher'), handler)
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: { message: "Unauthorized" },
        message: "Authentication required",
      });
    }

    const userRoles = req.user.roles || [req.user.role];
    const hasRole = userRoles.some(
      (role) =>
        allowedRoles.includes(role) ||
        (role === "school_admin" && allowedRoles.includes("admin")) ||
        (role === "admin" && allowedRoles.includes("school_admin"))
    );

    if (!hasRole) {
      return res.status(403).json({
        success: false,
        error: { message: "Forbidden — insufficient role" },
        message: "Insufficient permissions",
      });
    }

    next();
  };
}

module.exports = {
  verifyToken,
  authenticateToken: verifyToken,
  requireRole,
  ROLES,
};
