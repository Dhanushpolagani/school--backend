require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "school_erp",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  max: 10,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (error) => {
  console.error("Unexpected database pool error:", error.message);
});

module.exports = pool;
