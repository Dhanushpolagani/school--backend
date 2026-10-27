/**
 * Database Seed Runner
 * Executes db/seed/seed.sql against the configured database.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

async function runSeed() {
  console.log('🌱 Starting database seed...');
  const seedFile = path.join(__dirname, '../db/seed/seed.sql');

  if (!fs.existsSync(seedFile)) {
    console.error(`Seed file not found: ${seedFile}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(seedFile, 'utf8');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('✅ Database seeded successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seeding failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runSeed();
}

module.exports = { runSeed };
