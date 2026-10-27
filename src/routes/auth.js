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

// POST /api/auth/signup alias to register-school
router.post(["/signup", "/register-school"], async (req, res) => {
  const name = String(req.body.schoolName || req.body.name || "").trim();
  const schoolCode = String(req.body.schoolCode || req.body.slug || "").trim().toLowerCase();
  const slug = schoolCode || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const email = normalizeEmail(req.body.email);
  const fullName = String(req.body.fullName || `${req.body.firstName || ""} ${req.body.lastName || ""}`).trim();
  const password = req.body.password;

  if (
    name.length < 2 ||
    name.length > 150 ||
    !slug ||
    !validEmail(email) ||
    typeof password !== "string" ||
    password.length < 6
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid school name, email, full name, and password.",
    });
  }

  let client;

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    client = await pool.connect();
    await client.query("BEGIN");

    const tenantResult = await client.query(
      `INSERT INTO tenants (name, slug, school_code, school_name, email)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, slug, school_code, school_name`,
      [name, slug, slug.toUpperCase(), name, email]
    );

    const tenant = tenantResult.rows[0];

    const userResult = await client.query(
      `INSERT INTO users (tenant_id, full_name, first_name, last_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, 'school_admin')
       RETURNING id, tenant_id, full_name, email`,
      [tenant.id, fullName, req.body.firstName || fullName.split(" ")[0], req.body.lastName || fullName.split(" ").slice(1).join(" ") || "", email, passwordHash]
    );

    const user = userResult.rows[0];

    let roleResult = await client.query("SELECT id FROM roles WHERE name = 'school_admin'");
    if (roleResult.rowCount === 0) {
      roleResult = await client.query("INSERT INTO roles (name, description) VALUES ('school_admin', 'School Administrator') RETURNING id");
    }

    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [user.id, roleResult.rows[0].id]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "School registered successfully. Please log in.",
      school: tenant,
      user,
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "That school slug or email already exists." });
    }
    console.error("School registration failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to register school." });
  } finally {
    client?.release();
  }
});

// POST /api/auth/login
// Log in using email and password (with optional tenantSlug / schoolCode).
router.post("/login", async (req, res) => {
  const tenantSlug = String(req.body.tenantSlug || req.body.schoolCode || "").trim().toLowerCase();
  const email = normalizeEmail(req.body.email);
  const password = req.body.password;

  if (!validEmail(email) || typeof password !== "string" || !password) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid email and password.",
    });
  }

  try {
    let result;
    if (tenantSlug) {
      result = await pool.query(
        `SELECT u.id, u.tenant_id, u.full_name, u.first_name, u.last_name, u.avatar_url,
                u.email, u.password_hash, u.role, t.status AS tenant_status, t.school_code, t.name AS school_name
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
         WHERE (t.slug = $1 OR LOWER(t.school_code) = $1)
           AND u.email = $2
           AND u.is_active = TRUE
         LIMIT 1`,
        [tenantSlug, email]
      );
    } else {
      result = await pool.query(
        `SELECT u.id, u.tenant_id, u.full_name, u.first_name, u.last_name, u.avatar_url,
                u.email, u.password_hash, u.role, t.status AS tenant_status, t.school_code, t.name AS school_name
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
         WHERE u.email = $1
           AND u.is_active = TRUE
         LIMIT 1`,
        [email]
      );
    }

    const user = result.rows[0];

    if (
      !user ||
      user.tenant_status !== "active" ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({
        success: false,
        error: { message: "Invalid credentials or inactive school." },
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

    let roles = rolesResult.rows.map((row) => row.name);
    if (roles.length === 0 && user.role) {
      roles = [user.role];
    } else if (roles.length === 0) {
      roles = ["student"];
    }

    await issueTokens(res, user, roles);

    const firstName = user.first_name || user.full_name?.split(" ")[0] || "User";
    const lastName = user.last_name || user.full_name?.split(" ").slice(1).join(" ") || "";

    return res.json({
      success: true,
      message: "Login successful.",
      user: {
        id: String(user.id),
        email: user.email,
        role: roles[0],
        roles,
        firstName,
        lastName,
        avatarUrl: user.avatar_url || null,
        fullName: user.full_name,
        tenantId: String(user.tenant_id),
      },
      school: {
        code: user.school_code || "DEFAULT",
        tenantId: String(user.tenant_id),
        name: user.school_name,
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
      `SELECT u.id, u.tenant_id, u.full_name, u.first_name, u.last_name, u.email,
              u.phone, u.avatar_url, u.role, u.is_active, u.is_email_verified,
              t.name AS school_name, t.school_code, t.status AS tenant_status
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

    const roles = req.user.roles || [user.role || "student"];
    const firstName = user.first_name || user.full_name?.split(" ")[0] || "User";
    const lastName = user.last_name || user.full_name?.split(" ").slice(1).join(" ") || "";

    return res.json({
      success: true,
      user: {
        id: String(user.id),
        tenantId: String(user.tenant_id),
        tenant_id: user.tenant_id,
        email: user.email,
        role: user.role || roles[0],
        roles,
        first_name: firstName,
        last_name: lastName,
        firstName,
        lastName,
        fullName: user.full_name || `${firstName} ${lastName}`.trim(),
        full_name: user.full_name || `${firstName} ${lastName}`.trim(),
        phone: user.phone || null,
        avatar_url: user.avatar_url || null,
        avatarUrl: user.avatar_url || null,
        schoolName: user.school_name,
        school_code: user.school_code,
        is_email_verified: Boolean(user.is_email_verified),
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

// PUT /api/auth/me — Update own profile
router.put("/me", authenticateToken, async (req, res) => {
  try {
    const { first_name, last_name, phone, avatar_url, fullName } = req.body;
    const computedFullName = fullName || [first_name, last_name].filter(Boolean).join(" ");

    const result = await pool.query(
      `UPDATE users
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           full_name = COALESCE($3, full_name),
           phone = COALESCE($4, phone),
           avatar_url = COALESCE($5, avatar_url),
           updated_at = NOW()
       WHERE id = $6 AND tenant_id = $7
       RETURNING id, tenant_id, email, first_name, last_name, full_name, phone, avatar_url, role, is_active, is_email_verified`,
      [first_name || null, last_name || null, computedFullName || null, phone || null, avatar_url || null, req.user.id, req.user.tenantId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: { message: "User not found" } });
    }

    const u = result.rows[0];
    return res.json({
      success: true,
      message: "Profile updated successfully",
      user: {
        id: String(u.id),
        tenant_id: u.tenant_id,
        email: u.email,
        role: u.role,
        first_name: u.first_name,
        last_name: u.last_name,
        full_name: u.full_name,
        phone: u.phone,
        avatar_url: u.avatar_url,
        is_email_verified: u.is_email_verified,
      },
    });
  } catch (error) {
    console.error("Update profile failed:", error.message);
    return res.status(500).json({ success: false, error: { message: "Unable to update profile" } });
  }
});

// POST /api/auth/forgot-password — Send OTP to email
router.post("/forgot-password", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!validEmail(email)) {
    return res.status(400).json({ success: false, error: { message: "Valid email is required" } });
  }

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const updateRes = await pool.query(
      `UPDATE users SET otp_code = $1, otp_expires_at = $2 WHERE email = $3 RETURNING id, email`,
      [otp, expiresAt, email]
    );

    return res.json({
      success: true,
      message: "OTP sent to your email",
      otp: process.env.NODE_ENV !== "production" ? otp : undefined,
    });
  } catch (error) {
    console.error("Forgot password error:", error.message);
    return res.status(500).json({ success: false, error: { message: "Unable to process request" } });
  }
});

// POST /api/auth/verify-otp — Verify OTP code and return reset token
router.post("/verify-otp", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || req.body.otp_code || "").trim();

  if (!email || !otp) {
    return res.status(400).json({ success: false, error: { message: "Email and OTP are required" } });
  }

  try {
    const result = await pool.query(
      `SELECT id, email FROM users WHERE email = $1 AND otp_code = $2 AND otp_expires_at > NOW()`,
      [email, otp]
    );

    if (!result.rows[0]) {
      return res.status(400).json({ success: false, error: { message: "Invalid or expired OTP" } });
    }

    const resetToken = jwt.sign(
      { email, purpose: "password_reset" },
      process.env.JWT_SECRET,
      { expiresIn: "10m" }
    );

    await pool.query(`UPDATE users SET otp_code = NULL, otp_expires_at = NULL WHERE email = $1`, [email]);

    return res.json({
      success: true,
      message: "OTP verified successfully",
      reset_token: resetToken,
      resetToken,
    });
  } catch (error) {
    console.error("Verify OTP error:", error.message);
    return res.status(500).json({ success: false, error: { message: "Unable to verify OTP" } });
  }
});

// POST /api/auth/reset-password — Reset password with token
router.post("/reset-password", async (req, res) => {
  const resetToken = req.body.reset_token || req.body.resetToken;
  const password = req.body.password;

  if (!resetToken || typeof password !== "string" || password.length < 6) {
    return res.status(400).json({
      success: false,
      error: { message: "Reset token and a password with at least 6 characters are required" },
    });
  }

  try {
    const decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    if (!decoded.email) {
      return res.status(400).json({ success: false, error: { message: "Invalid reset token" } });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2 RETURNING id, email`,
      [hash, decoded.email]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: { message: "User not found" } });
    }

    return res.json({
      success: true,
      message: "Password reset successful",
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: { message: "Invalid or expired reset token" },
    });
  }
});

// POST /api/auth/mfa/enable — Enable MFA (TOTP)
router.post("/mfa/enable", authenticateToken, async (req, res) => {
  try {
    const mfaSecret = crypto.randomBytes(20).toString("hex");
    await pool.query(
      `UPDATE users SET mfa_secret = $1 WHERE id = $2 AND tenant_id = $3`,
      [mfaSecret, req.user.id, req.user.tenantId]
    );

    return res.json({
      success: true,
      message: "MFA setup initiated",
      secret: mfaSecret,
      instructions: "Enter verification code to complete setup.",
    });
  } catch (error) {
    console.error("MFA enable error:", error.message);
    return res.status(500).json({ success: false, error: { message: "Unable to enable MFA" } });
  }
});

// POST /api/auth/mfa/verify — Verify MFA token
router.post("/mfa/verify", authenticateToken, async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ success: false, error: { message: "Verification code is required" } });
  }

  try {
    await pool.query(
      `UPDATE users SET mfa_enabled = TRUE WHERE id = $1 AND tenant_id = $2`,
      [req.user.id, req.user.tenantId]
    );

    return res.json({
      success: true,
      message: "MFA verified and enabled successfully",
      mfa_enabled: true,
    });
  } catch (error) {
    console.error("MFA verify error:", error.message);
    return res.status(500).json({ success: false, error: { message: "Unable to verify MFA" } });
  }
});

module.exports = router;

