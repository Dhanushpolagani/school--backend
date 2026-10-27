const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const errorHandler = require("./middleware/errorHandler");
require("dotenv").config();

const app = express();

// ── Security & Performance ───────────────────────────
app.disable("x-powered-by");
app.use(helmet());
app.use(compression());
if (process.env.NODE_ENV !== "test") {
  app.use(morgan("combined"));
}
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiter ────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
app.use("/api", limiter);

// ── Route Imports ───────────────────────────────────
const authRoutes = require("./routes/auth");
const tenantRoutes = require("./routes/tenant");
const dashboardRoutes = require("./routes/dashboard");
const schoolAdminRoutes = require("./routes/schoolAdmin");
const studentsRoutes = require("./routes/students");
const parentsRoutes = require("./routes/parents");
const academicsRoutes = require("./routes/academics");
const timetableRoutes = require("./routes/timetable");
const examsRoutes = require("./routes/exams");
const attendanceRoutes = require("./routes/attendance");
const admissionsRoutes = require("./routes/admissions");
const financeRoutes = require("./routes/finance");
const hrRoutes = require("./routes/hr");
const payrollRoutes = require("./routes/payroll");
const transportRoutes = require("./routes/transport");
const libraryRoutes = require("./routes/library");
const hostelRoutes = require("./routes/hostel");
const inventoryRoutes = require("./routes/inventory");
const communicationRoutes = require("./routes/communication");
const reportsRoutes = require("./routes/reports");
const lmsRoutes = require("./routes/lms");
const certificatesRoutes = require("./routes/certificates");
const portalRoutes = require("./routes/portal");
const auditRoutes = require("./routes/audit");

// ── Core API Modules (Clean Standard Paths) ───────────
app.use("/api/auth", authRoutes);
app.use("/api/tenant", tenantRoutes);
app.use("/api/tenants", tenantRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/admin", schoolAdminRoutes);
app.use("/api/students", studentsRoutes);
app.use("/api/parents", parentsRoutes);
app.use("/api/academics", academicsRoutes);
app.use("/api/timetable", timetableRoutes);
app.use("/api/exams", examsRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/admissions", admissionsRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/hr", hrRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/transport", transportRoutes);
app.use("/api/library", libraryRoutes);
app.use("/api/hostel", hostelRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/communication", communicationRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/lms", lmsRoutes);
app.use("/api/certificates", certificatesRoutes);
app.use("/api/portal", portalRoutes);
app.use("/api/portals", portalRoutes);
app.use("/api/audit", auditRoutes);

// ── Legacy Endpoint Compatibility Aliases ───────────
app.use("/api/classes", academicsRoutes);
app.use("/api/examinations", examsRoutes);
app.use("/api/fees", financeRoutes);
app.use("/api/staff", hrRoutes.staffRouter || hrRoutes);
app.use("/api/leave", hrRoutes.leaveRouter || hrRoutes);
app.use("/api/purchase-orders", inventoryRoutes.purchaseOrdersRouter || inventoryRoutes);
app.use("/api/hostel-fees", hostelRoutes.feesRouter || hostelRoutes);
app.use("/api/hostel-attendance", hostelRoutes.attendanceRouter || hostelRoutes);
app.use("/api/announcements", communicationRoutes);
app.use("/api/notifications", communicationRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api/security", auditRoutes);
app.use("/api", communicationRoutes);
app.use("/api", auditRoutes);

// ── Health Check ────────────────────────────────────
app.get("/api/health", async (req, res) => {
  const pool = require("./config/db");
  try {
    const result = await pool.query(
      "SELECT current_database() AS database, NOW() AS server_time"
    );
    res.json({
      success: true,
      message: "Smart School ERP API is running",
      database: result.rows[0].database,
      serverTime: result.rows[0].server_time,
    });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }
});

// ── Unknown Route Handler ───────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// ── Global Error Handler ────────────────────────────
app.use(errorHandler);

module.exports = app;
