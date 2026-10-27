
const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
  let token = req.cookies?.access_token;

  if (!token && req.headers?.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.substring(7).trim();
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (
      !payload.sub ||
      !payload.tenantId ||
      !Array.isArray(payload.roles)
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    req.user = {
      id: String(payload.sub),
      tenantId: String(payload.tenantId),
      roles: payload.roles,
    };

    next();
} catch (error) {
  console.error("JWT verification failed:", error.name, error.message);

  return res.status(401).json({
    success: false,
    message: "Invalid or expired authentication token",
  });
}
}

module.exports = { authenticateToken };
