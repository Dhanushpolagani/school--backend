const fs = require("fs");
const path = require("path");
const pool = require("./src/config/db");

async function run() {
  const migrationsDir = path.join(__dirname, "db/migrations");
  const files = [
    "018_admissions_enrolment.sql",
    "019_purchase_orders.sql",
    "020_payroll.sql",
    "021_notifications_announcements.sql",
    "022_lms.sql",
    "023_audit_logs.sql",
    "024_portals_and_roles.sql",
    "025_certificates.sql"
  ];

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    if (!fs.existsSync(filePath)) {
      console.log(`Skipping missing file: ${file}`);
      continue;
    }

    console.log(`Applying ${file}...`);
    const sql = fs.readFileSync(filePath, "utf8");
    const client = await pool.connect();
    try {
      await client.query(sql);
      console.log(`✓ Applied ${file}`);
    } catch (err) {
      console.error(`✗ Error applying ${file}:`, err.message);
      client.release();
      await pool.end();
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log("All new migrations applied successfully!");
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
