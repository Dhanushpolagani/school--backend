const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();



const COOKIE_NAME = "access_token";
const REFRESH_COOKIE_NAME = "refresh_token";

const ACCESS_TOKEN_LIFETIME = 15 * 60 * 1000;
const REFRESH_TOKEN_DAYS = 7;
const REFRESH_TOKEN_LIFETIME =
  REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

function clearAuthCookies(res) {
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };

  res.clearCookie(COOKIE_NAME, options);
  res.clearCookie(REFRESH_COOKIE_NAME, options);
}

function createToken(user, roles) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters");
  }

  return jwt.sign(
    {
      tenantId: String(user.tenant_id),
      roles,
      tokenType: "access",
    },
    process.env.JWT_SECRET,
    {
      subject: String(user.id),
      expiresIn: process.env.JWT_EXPIRES_IN || "15m",
    }
  );
}

function createRefreshToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function issueTokens(res, user, roles, client = pool) {
  const accessToken = createToken(user, roles);
  const refreshToken = createRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);

  await client.query(
    `INSERT INTO refresh_sessions
       (user_id, tenant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [
      user.id,
      user.tenant_id,
      refreshTokenHash,
      new Date(Date.now() + REFRESH_TOKEN_LIFETIME),
    ]
  );

  res.cookie(
    COOKIE_NAME,
    accessToken,
    cookieOptions(ACCESS_TOKEN_LIFETIME)
  );

  res.cookie(
    REFRESH_COOKIE_NAME,
    refreshToken,
    cookieOptions(REFRESH_TOKEN_LIFETIME)
  );
}



function issueToken(res, user, roles) {
  const token = createToken(user, roles);
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Register a school and its first administrator.
router.post("/register-school", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const slug = String(req.body.slug || "").trim().toLowerCase();
  const email = normalizeEmail(req.body.email);
  const fullName = String(req.body.fullName || "").trim();
  const password = req.body.password;

  if (
    name.length < 2 ||
    name.length > 150 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    slug.length > 100 ||
    !validEmail(email) ||
    email.length > 255 ||
    fullName.length < 2 ||
    fullName.length > 150 ||
    typeof password !== "string" ||
    password.length < 12 ||
    Buffer.byteLength(password, "utf8") > 72
  ) {
    return res.status(400).json({
      success: false,
      message:
        "Provide a valid school name, slug, email, full name, and password (12–72 UTF-8 bytes).",
    });
  }

  let client;

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    client = await pool.connect();
    await client.query("BEGIN");

    const tenantResult = await client.query(
      `INSERT INTO tenants (name, slug, email)
       VALUES ($1, $2, $3)
       RETURNING id, name, slug`,
      [name, slug, email]
    );

    const tenant = tenantResult.rows[0];

    const userResult = await client.query(
      `INSERT INTO users (tenant_id, full_name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, full_name, email`,
      [tenant.id, fullName, email, passwordHash]
    );

    const user = userResult.rows[0];

    const roleResult = await client.query(
      "SELECT id FROM roles WHERE name = $1",
      ["school_admin"]
    );

    if (roleResult.rowCount !== 1) {
      throw new Error("Required school_admin role is missing");
    }

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
      [user.id, roleResult.rows[0].id]
    );

    await client.query("COMMIT");

    // Registration does not automatically log in the new administrator.
    return res.status(201).json({
      success: true,
      message: "School registered successfully. Please log in.",
      school: tenant,
      user,
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "That school slug or account already exists.",
      });
    }

    console.error("School registration failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to register school.",
    });
  } finally {
    client?.release();
  }
});

// Log in using school slug, email and password.
router.post("/login", async (req, res) => {
  const tenantSlug = String(req.body.tenantSlug || "").trim().toLowerCase();
  const email = normalizeEmail(req.body.email);
  const password = req.body.password;

  if (
    !tenantSlug ||
    !validEmail(email) ||
    typeof password !== "string" ||
    password.length > 72
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide your school slug, email and password.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.tenant_id, u.full_name, u.email,
              u.password_hash, t.status AS tenant_status
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE t.slug = $1
         AND u.email = $2
         AND u.is_active = TRUE
       LIMIT 1`,
      [tenantSlug, email]
    );

    const user = result.rows[0];

    if (
      !user ||
      user.tenant_status !== "active" ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials or inactive school.",
      });
    }

    const rolesResult = await pool.query(
      `SELECT r.name
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1
       ORDER BY r.name`,
      [user.id]
    );

    const roles = rolesResult.rows.map((row) => row.name);

    if (roles.length === 0) {
      return res.status(403).json({
        success: false,
        message: "No roles are assigned to this account.",
      });
    }

    await issueTokens(res, user, roles);
    return res.json({
      success: true,
      message: "Login successful.",
      user: {
        id: String(user.id),
        tenantId: String(user.tenant_id),
        fullName: user.full_name,
        email: user.email,
        roles,
      },
    });
  } catch (error) {
    console.error("Login failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to log in.",
    });
  }
});

router.post("/refresh", async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];

  if (!refreshToken) {
    clearAuthCookies(res);
    return res.status(401).json({
      success: false,
      message: "Refresh token required. Please log in again.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tokenHash = hashRefreshToken(refreshToken);

    const result = await client.query(
      `SELECT
         rs.id AS session_id,
         rs.user_id,
         rs.tenant_id,
         rs.expires_at,
         rs.revoked_at,
         u.is_active,
         t.status AS tenant_status
       FROM refresh_sessions rs
       JOIN users u
         ON u.id = rs.user_id
        AND u.tenant_id = rs.tenant_id
       JOIN tenants t ON t.id = rs.tenant_id
       WHERE rs.token_hash = $1
       FOR UPDATE OF rs`,
      [tokenHash]
    );

    const session = result.rows[0];

    if (!session) {
      await client.query("ROLLBACK");
      clearAuthCookies(res);

      return res.status(401).json({
        success: false,
        message: "Invalid refresh token. Please log in again.",
      });
    }

    // A previously rotated token was reused. Revoke all sessions
    // for this user and tenant as a precaution.
    if (session.revoked_at) {
      await client.query(
        `UPDATE refresh_sessions
         SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE user_id = $1 AND tenant_id = $2`,
        [session.user_id, session.tenant_id]
      );

      await client.query("COMMIT");
      clearAuthCookies(res);

      return res.status(401).json({
        success: false,
        message: "Refresh token reuse detected. Please log in again.",
      });
    }

    const expired =
      new Date(session.expires_at).getTime() <= Date.now();

    if (expired || !session.is_active ||
        session.tenant_status !== "active") {
      await client.query(
        `UPDATE refresh_sessions
         SET revoked_at = NOW()
         WHERE id = $1`,
        [session.session_id]
      );

      await client.query("COMMIT");
      clearAuthCookies(res);

      return res.status(401).json({
        success: false,
        message: "Session expired or account inactive. Please log in again.",
      });
    }

    const rolesResult = await client.query(
      `SELECT r.name
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1
       ORDER BY r.name`,
      [session.user_id]
    );

    const roles = rolesResult.rows.map((row) => row.name);

    if (roles.length === 0) {
      await client.query(
        `UPDATE refresh_sessions
         SET revoked_at = NOW()
         WHERE user_id = $1 AND tenant_id = $2
           AND revoked_at IS NULL`,
        [session.user_id, session.tenant_id]
      );

      await client.query("COMMIT");
      clearAuthCookies(res);

      return res.status(403).json({
        success: false,
        message: "No roles are assigned to this account.",
      });
    }

    const user = {
      id: session.user_id,
      tenant_id: session.tenant_id,
    };

    const newAccessToken = createToken(user, roles);
    const newRefreshToken = createRefreshToken();
    const newRefreshHash = hashRefreshToken(newRefreshToken);

    const inserted = await client.query(
      `INSERT INTO refresh_sessions
         (user_id, tenant_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        session.user_id,
        session.tenant_id,
        newRefreshHash,
        new Date(Date.now() + REFRESH_TOKEN_LIFETIME),
      ]
    );

    await client.query(
      `UPDATE refresh_sessions
       SET revoked_at = NOW(), replaced_by = $1
       WHERE id = $2`,
      [inserted.rows[0].id, session.session_id]
    );

    await client.query("COMMIT");

    res.cookie(
      COOKIE_NAME,
      newAccessToken,
      cookieOptions(ACCESS_TOKEN_LIFETIME)
    );

    res.cookie(
      REFRESH_COOKIE_NAME,
      newRefreshToken,
      cookieOptions(REFRESH_TOKEN_LIFETIME)
    );

    return res.json({
      success: true,
      message: "Session refreshed successfully.",
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("Token refresh failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to refresh session.",
    });
  } finally {
    client.release();
  }
});

// Log out by clearing the browser's authentication cookie.

router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];

  try {
    if (refreshToken) {
      await pool.query(
        `UPDATE refresh_sessions
         SET revoked_at = NOW()
         WHERE token_hash = $1
           AND revoked_at IS NULL`,
        [hashRefreshToken(refreshToken)]
      );
    }

    clearAuthCookies(res);

    return res.json({
      success: true,
      message: "Logged out successfully.",
    });
  } catch (error) {
    console.error("Logout failed:", error.message);

    clearAuthCookies(res);

    return res.status(500).json({
      success: false,
      message: "Unable to complete logout.",
    });
  }
});


// Return the currently authenticated user.
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.tenant_id, u.full_name, u.email,
              u.is_active, t.name AS school_name, t.status AS tenant_status
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 AND u.tenant_id = $2`,
      [req.user.id, req.user.tenantId]
    );

    const user = result.rows[0];

    if (!user || !user.is_active || user.tenant_status !== "active") {
      res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });

      return res.status(401).json({
        success: false,
        message: "Account is inactive or unavailable.",
      });
    }

    return res.json({
      success: true,
      user: {
        id: String(user.id),
        tenantId: String(user.tenant_id),
        fullName: user.full_name,
        email: user.email,
        schoolName: user.school_name,
        roles: req.user.roles,
      },
    });
  } catch (error) {
    console.error("Profile lookup failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to retrieve profile.",
    });
  }
});

module.exports = router;
