
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const app = express();
const classesRoutes = require("./routes/classes");
const authRoutes = require("./routes/auth");
const studentRoutes = require("./routes/students");
const attendanceRoutes = require("./routes/attendance");
const feesRoutes = require("./routes/fees");
const transportRoutes = require("./routes/transport");
const staffRoutes = require("./routes/staff");
const leaveRoutes = require("./routes/leave");
const hostelRoutes = require("./routes/hostel");
const hostelFeesRoutes = require("./routes/hostel-fees");
const examinationsRoutes = require("./routes/examinations");
const hostelAttendanceRoutes = require("./routes/hostel-attendance");
const libraryRoutes = require("./routes/library");
const inventoryRoutes = require("./routes/inventory");
const parentsRoutes = require("./routes/parents");
const purchaseOrdersRoutes = require("./routes/purchase-orders");
const payrollRoutes = require("./routes/payroll");
const dashboardRoutes = require("./routes/dashboard");
const notificationsRoutes = require("./routes/notifications");
const portalsRoutes = require("./routes/portals");
const lmsRoutes = require("./routes/lms");
const auditSecurityRoutes = require("./routes/audit-security");
const admissionsRoutes = require("./routes/admissions");
const certificatesRoutes = require("./routes/certificates");

app.disable("x-powered-by");
app.use(helmet());

app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:5173",
  credentials: true,
}));

// Parse request data and cookies before registering routes.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Rate-limit API requests.
app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
}));

// Register each route exactly once.
app.use("/api/auth", authRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/classes", classesRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/fees", feesRoutes);
app.use("/api/transport", transportRoutes);
app.use("/api/leave", leaveRoutes);

app.use("/api/examinations", examinationsRoutes);
app.use("/api/hostel", hostelRoutes);
app.use("/api/hostel-fees", hostelFeesRoutes);
app.use("/api/hostel-attendance", hostelAttendanceRoutes);
app.use("/api/library", libraryRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/parents", parentsRoutes);

// New Modules:
app.use("/api/admissions", admissionsRoutes);
app.use("/api/purchase-orders", purchaseOrdersRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api", notificationsRoutes);
app.use("/api/portal", portalsRoutes);
app.use("/api/lms", lmsRoutes);
app.use("/api", auditSecurityRoutes);
app.use("/api/certificates", certificatesRoutes);
app.get("/api/health", async (req, res) => {
  const pool = require("./config/db");

  try {
    const result = await pool.query(
      "SELECT current_database() AS database, NOW() AS server_time"
    );

    res.json({
      success: true,
      message: "School ERP API is running",
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

// Handle unknown routes.
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Central error handler.
app.use((err, req, res, next) => {
  console.error("Application error:", err.message);

  if (res.headersSent) return next(err);

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

module.exports = app;
