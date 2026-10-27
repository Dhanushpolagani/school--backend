const express = require("express");
const pool = require("../config/db");
const { verifyToken, requireRole } = require("../middleware/auth");
const { resolveTenant } = require("../middleware/tenant");

const router = express.Router();
router.use(verifyToken, resolveTenant);

// ---------------------------------------------------------------------------
// 1. Student Reports
// ---------------------------------------------------------------------------
router.get(["/", "/student", "/students"], async (req, res, next) => {
  try {
    const totalStudents = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'active') AS active,
         COUNT(*) FILTER (WHERE gender ILIKE 'male%') AS male_count,
         COUNT(*) FILTER (WHERE gender ILIKE 'female%') AS female_count
       FROM students
       WHERE tenant_id = $1`,
      [req.tenantId]
    );

    const byClass = await pool.query(
      `SELECT c.name AS class_name, COUNT(s.id)::INTEGER AS student_count
       FROM school_classes c
       LEFT JOIN students s ON s.class_id = c.id AND s.tenant_id = c.tenant_id AND s.status = 'active'
       WHERE c.tenant_id = $1
       GROUP BY c.id, c.name
       ORDER BY c.name`,
      [req.tenantId]
    );

    res.json({
      success: true,
      data: {
        summary: totalStudents.rows[0],
        byClass: byClass.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 2. Attendance Reports
// ---------------------------------------------------------------------------
router.get("/attendance", async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const result = await pool.query(
      `SELECT
         COUNT(*) AS total_records,
         COUNT(*) FILTER (WHERE status = 'present') AS present_count,
         COUNT(*) FILTER (WHERE status = 'absent') AS absent_count,
         COUNT(*) FILTER (WHERE status = 'late') AS late_count
       FROM student_attendance
       WHERE tenant_id = $1`,
      [req.tenantId]
    );

    const staffResult = await pool.query(
      `SELECT
         COUNT(*) AS total_staff,
         COUNT(*) FILTER (WHERE status = 'active') AS active_staff
       FROM staff
       WHERE tenant_id = $1`,
      [req.tenantId]
    );

    res.json({
      success: true,
      data: {
        studentAttendance: result.rows[0],
        staffSummary: staffResult.rows[0],
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 3. Financial Reports
// ---------------------------------------------------------------------------
router.get(["/financial", "/finance"], requireRole("super_admin", "school_admin", "admin", "accountant"), async (req, res, next) => {
  try {
    const payments = await pool.query(
      `SELECT
         COALESCE(SUM(amount_paise), 0) AS total_collected_paise,
         COUNT(*) AS payment_count
       FROM fee_payments
       WHERE tenant_id = $1`,
      [req.tenantId]
    );

    const assignments = await pool.query(
      `SELECT
         COALESCE(SUM(net_amount_paise), 0) AS total_assigned_paise,
         COALESCE(SUM(paid_amount_paise), 0) AS total_received_paise,
         COALESCE(SUM(net_amount_paise - paid_amount_paise), 0) AS total_outstanding_paise
       FROM student_fee_assignments
       WHERE tenant_id = $1`,
      [req.tenantId]
    );

    res.json({
      success: true,
      data: {
        totalCollected: Number(payments.rows[0].total_collected_paise) / 100,
        totalAssigned: Number(assignments.rows[0].total_assigned_paise) / 100,
        totalOutstanding: Number(assignments.rows[0].total_outstanding_paise) / 100,
        totalTransactions: Number(payments.rows[0].payment_count),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 4. Academic Performance Reports
// ---------------------------------------------------------------------------
router.get(["/performance", "/academics"], async (req, res, next) => {
  try {
    const examsResult = await pool.query(
      `SELECT e.id, e.name, e.academic_year, e.status,
              COUNT(es.id)::INTEGER AS total_schedules
       FROM examinations e
       LEFT JOIN exam_schedules es ON es.examination_id = e.id AND es.tenant_id = e.tenant_id
       WHERE e.tenant_id = $1
       GROUP BY e.id
       ORDER BY e.start_date DESC LIMIT 5`,
      [req.tenantId]
    );

    res.json({
      success: true,
      data: {
        recentExams: examsResult.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 5. Generic Report Export
// ---------------------------------------------------------------------------
router.post("/export", requireRole("super_admin", "school_admin", "admin", "accountant"), async (req, res, next) => {
  const { reportType = "student", format = "json" } = req.body;
  res.json({
    success: true,
    message: `Report ${reportType} generated in ${format} format.`,
    downloadUrl: `/api/reports/${reportType}`,
  });
});

module.exports = router;
