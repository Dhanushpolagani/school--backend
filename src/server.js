
console.log("Starting School ERP backend...");

require("dotenv").config();

const app = require("./app");
const pool = require("./config/db");

const PORT = Number(process.env.PORT || 5000);

async function startServer() {
  try {
    await pool.query("SELECT 1");
    console.log("PostgreSQL connection successful.");

    app.listen(PORT, () => {
      console.log(`School ERP API running at http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
    });
  } catch (error) {
    console.error("Startup failed:", error.message);
    process.exitCode = 1;
    await pool.end();
  }
}

startServer();
