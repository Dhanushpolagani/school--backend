
require("dotenv").config();

const bcrypt = require("bcryptjs");
const pool = require("./src/config/db");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function main() {
  let client;

  try {
    const email = "admin@demo-school.test";
    const fullName = await ask("Enter administrator's full name: ");
    const password = await ask(
      "Enter a new password (minimum 12 characters): "
    );

    if (fullName.trim().length < 2) {
      throw new Error("Full name must contain at least 2 characters.");
    }

    if (
      password.length < 12 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      throw new Error("Password must be 12–72 UTF-8 bytes.");
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const schoolResult = await client.query(
      `SELECT id, name, slug, status
       FROM tenants
       WHERE slug = $1
       FOR UPDATE`,
      ["demo-school"]
    );

    if (schoolResult.rowCount !== 1) {
      throw new Error("Existing school demo-school was not found.");
    }

    const school = schoolResult.rows[0];

    if (school.status !== "active") {
      throw new Error("The school is not active.");
    }

    const existingUser = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [email]
    );

    if (existingUser.rowCount > 0) {
      throw new Error(
        "This email already exists. No account was created."
      );
    }

    const roleResult = await client.query(
      `SELECT id FROM roles WHERE name = $1`,
      ["school_admin"]
    );

    if (roleResult.rowCount !== 1) {
      throw new Error("The school_admin role was not found.");
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const userResult = await client.query(
      `INSERT INTO users
         (tenant_id, full_name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, full_name, email`,
      [school.id, fullName.trim(), email, passwordHash]
    );

    const user = userResult.rows[0];

    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, $2)`,
      [user.id, roleResult.rows[0].id]
    );

    await client.query("COMMIT");

    console.log("\nAdministrator created successfully.");
    console.log("School:", school.name);
    console.log("School slug:", school.slug);
    console.log("User ID:", user.id);
    console.log("Full name:", user.full_name);
    console.log("Email:", user.email);
    console.log("Role: school_admin");
    console.log("Password: not displayed");
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("\nSetup failed:", error.message);
    process.exitCode = 1;
  } finally {
    client?.release();
    rl.close();
    await pool.end();
  }
}

main();
