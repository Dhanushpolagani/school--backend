const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

function tenantIdOf(req) {
  return req.user?.tenantId;
}

function requireTenant(req, res) {
  const tenantId = tenantIdOf(req);
  if (!tenantId) {
    res.status(401).json({
      success: false,
      message: "Tenant authentication required.",
    });
    return null;
  }
  return tenantId;
}

// GET /api/dashboard/quick-stats
// Lightweight summary stats for header badges and widgets
router.get("/quick-stats", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const statsResult = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM students WHERE tenant_id = $1 AND status = 'active') AS active_students,
         (SELECT COUNT(*) FROM staff WHERE tenant_id = $1 AND status = 'active') AS active_staff,
         (SELECT COUNT(*) FROM admission_applications WHERE tenant_id = $1 AND status IN ('submitted', 'under_review')) AS pending_admissions,
         (SELECT COUNT(*) FROM inventory_items WHERE tenant_id = $1 AND status = 'active' AND quantity_on_hand <= reorder_level) AS low_stock_alerts`,
      [tenantId]
    );

    res.json({
      success: true,
      data: statsResult.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dashboard/overview
// Complete 360-degree executive KPI overview
router.get("/overview", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    // 1. Student & Staff counts
    const countsResult = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM students WHERE tenant_id = $1) AS total_students,
         (SELECT COUNT(*) FROM students WHERE tenant_id = $1 AND status = 'active') AS active_students,
         (SELECT COUNT(*) FROM students WHERE tenant_id = $1 AND gender = 'male') AS male_students,
         (SELECT COUNT(*) FROM students WHERE tenant_id = $1 AND gender = 'female') AS female_students,
         (SELECT COUNT(*) FROM staff WHERE tenant_id = $1) AS total_staff,
         (SELECT COUNT(*) FROM staff WHERE tenant_id = $1 AND status = 'active') AS active_staff,
         (SELECT COUNT(*) FROM school_classes WHERE tenant_id = $1) AS total_classes`,
      [tenantId]
    );

    // 2. Financial Overview
    const financeResult = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(amount_paise), 0) FROM student_fee_assignments WHERE tenant_id = $1) AS total_billed_paise,
         (SELECT COALESCE(SUM(amount_paise), 0) FROM fee_payments WHERE tenant_id = $1) AS total_collected_paise`,
      [tenantId]
    );

    const billed = Number(financeResult.rows[0].total_billed_paise || 0);
    const collected = Number(financeResult.rows[0].total_collected_paise || 0);
    const pending = Math.max(0, billed - collected);
    const collectionRate = billed > 0 ? Math.round((collected / billed) * 100) : 100;

    // 3. Today's Attendance Overview
    const todayStr = new Date().toISOString().split("T")[0];
    const attendanceResult = await pool.query(
      `SELECT
         COUNT(*) AS total_marked,
         COUNT(*) FILTER (WHERE status = 'present') AS present_count,
         COUNT(*) FILTER (WHERE status = 'absent') AS absent_count,
         COUNT(*) FILTER (WHERE status = 'late') AS late_count
       FROM student_attendance
       WHERE tenant_id = $1 AND attendance_date = $2`,
      [tenantId, todayStr]
    );

    // 4. Admissions Summary
    const admissionsResult = await pool.query(
      `SELECT
         COUNT(*) AS total_applications,
         COUNT(*) FILTER (WHERE status IN ('submitted', 'under_review')) AS pending_review,
         COUNT(*) FILTER (WHERE status = 'approved') AS approved,
         COUNT(*) FILTER (WHERE status = 'enrolled') AS enrolled
       FROM admission_applications
       WHERE tenant_id = $1`,
      [tenantId]
    );

    // 5. Operations: Hostel, Transport, Inventory, Library
    const operationsResult = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM transport_vehicles WHERE tenant_id = $1) AS transport_vehicles,
         (SELECT COUNT(*) FROM transport_routes WHERE tenant_id = $1) AS transport_routes,
         (SELECT COUNT(*) FROM hostel_allocations WHERE tenant_id = $1 AND status = 'active') AS hostel_students,
         (SELECT COUNT(*) FROM inventory_items WHERE tenant_id = $1 AND status = 'active' AND quantity_on_hand <= reorder_level) AS low_stock_items,
         (SELECT COUNT(*) FROM library_loans WHERE tenant_id = $1 AND status = 'issued') AS active_book_loans`,
      [tenantId]
    );

    // 6. Recent Audit Activities
    const recentActivity = await pool.query(
      `SELECT id, action, entity_type, entity_id, user_email, user_role, status, created_at
       FROM audit_logs
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT 8`,
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        students: countsResult.rows[0],
        finances: {
          totalBilledPaise: billed,
          totalCollectedPaise: collected,
          outstandingPaise: pending,
          collectionRatePercentage: collectionRate,
        },
        attendanceToday: {
          date: todayStr,
          ...attendanceResult.rows[0],
        },
        admissions: admissionsResult.rows[0],
        operations: operationsResult.rows[0],
        recentActivities: recentActivity.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dashboard/admissions
// Admissions funnel analytics and intake breakdown
router.get("/admissions", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const funnelResult = await pool.query(
      `SELECT
         status,
         COUNT(*) AS count
       FROM admission_applications
       WHERE tenant_id = $1
       GROUP BY status
       ORDER BY count DESC`,
      [tenantId]
    );

    const classDistribution = await pool.query(
      `SELECT
         COALESCE(applying_class_name, 'Unassigned') AS class_name,
         COUNT(*) AS total_applications,
         COUNT(*) FILTER (WHERE status = 'enrolled') AS enrolled_count
       FROM admission_applications
       WHERE tenant_id = $1
       GROUP BY applying_class_name
       ORDER BY total_applications DESC`,
      [tenantId]
    );

    const monthlyIntake = await pool.query(
      `SELECT
         TO_CHAR(created_at, 'YYYY-MM') AS month,
         COUNT(*) AS count
       FROM admission_applications
       WHERE tenant_id = $1
       GROUP BY TO_CHAR(created_at, 'YYYY-MM')
       ORDER BY month ASC
       LIMIT 12`,
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        funnel: funnelResult.rows,
        byClass: classDistribution.rows,
        monthlyTrend: monthlyIntake.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dashboard/finance
// Detailed finance and collection analytics
router.get("/finance", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const paymentMethods = await pool.query(
      `SELECT
         COALESCE(payment_method, 'other') AS payment_method,
         COUNT(*) AS transaction_count,
         COALESCE(SUM(amount_paise), 0) AS total_paise
       FROM fee_payments
       WHERE tenant_id = $1
       GROUP BY payment_method
       ORDER BY total_paise DESC`,
      [tenantId]
    );

    const categoryBreakdown = await pool.query(
      `SELECT
         fc.name AS category_name,
         COALESCE(SUM(sfa.amount_paise), 0) AS assigned_paise
       FROM student_fee_assignments sfa
       LEFT JOIN fee_structures fs ON fs.tenant_id = sfa.tenant_id AND fs.id = sfa.fee_structure_id
       LEFT JOIN fee_categories fc ON fc.tenant_id = sfa.tenant_id AND fc.id = fs.category_id
       WHERE sfa.tenant_id = $1
       GROUP BY fc.name
       ORDER BY assigned_paise DESC`,
      [tenantId]
    );

    const monthlyCollections = await pool.query(
      `SELECT
         TO_CHAR(payment_date, 'YYYY-MM') AS month,
         COUNT(*) AS transactions,
         COALESCE(SUM(amount_paise), 0) AS collected_paise
       FROM fee_payments
       WHERE tenant_id = $1
       GROUP BY TO_CHAR(payment_date, 'YYYY-MM')
       ORDER BY month ASC
       LIMIT 12`,
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        paymentModes: paymentMethods.rows,
        categories: categoryBreakdown.rows,
        monthlyCollections: monthlyCollections.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dashboard/attendance
// Attendance trends across the last 14 days
router.get("/attendance", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const dailyTrend = await pool.query(
      `SELECT
         attendance_date::text AS date,
         COUNT(*) AS total_marked,
         COUNT(*) FILTER (WHERE status = 'present') AS present_count,
         COUNT(*) FILTER (WHERE status = 'absent') AS absent_count,
         COUNT(*) FILTER (WHERE status = 'late') AS late_count,
         ROUND(
           (COUNT(*) FILTER (WHERE status = 'present')::numeric / NULLIF(COUNT(*), 0)) * 100,
           1
         ) AS attendance_percentage
       FROM student_attendance
       WHERE tenant_id = $1 AND attendance_date >= CURRENT_DATE - INTERVAL '14 days'
       GROUP BY attendance_date
       ORDER BY attendance_date ASC`,
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        trend: dailyTrend.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dashboard/academics
// Academic exam performance summary
router.get("/academics", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const examsSummary = await pool.query(
      `SELECT
         COUNT(*) AS total_exams,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed_exams,
         COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled_exams
       FROM examinations
       WHERE tenant_id = $1`,
      [tenantId]
    );

    const marksStats = await pool.query(
      `SELECT
         COUNT(*) AS total_evaluations,
         ROUND(AVG(marks_obtained), 1) AS average_score,
         COUNT(*) FILTER (WHERE is_absent = true) AS absent_count
       FROM exam_marks
       WHERE tenant_id = $1`,
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        exams: examsSummary.rows[0],
        scores: marksStats.rows[0],
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
