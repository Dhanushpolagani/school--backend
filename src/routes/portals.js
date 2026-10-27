const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();

router.use(authenticateToken);

function tenantIdOf(req) {
  return req.user?.tenantId;
}

function isPositiveId(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0;
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

// Helper: Resolve studentId for current logged-in user
async function resolveCurrentStudentId(req) {
  const tenantId = tenantIdOf(req);
  const userId = req.user.id;

  // 1. Direct link in student_users
  const linkRes = await pool.query(
    `SELECT student_id FROM student_users WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId]
  );
  if (linkRes.rowCount > 0) {
    return linkRes.rows[0].student_id;
  }

  // 2. Fallback: match via user email
  const userRes = await pool.query(
    `SELECT email FROM users WHERE tenant_id = $1 AND id = $2`,
    [tenantId, userId]
  );
  if (userRes.rowCount > 0) {
    const email = userRes.rows[0].email;
    const stuRes = await pool.query(
      `SELECT id FROM students WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email]
    );
    if (stuRes.rowCount > 0) {
      return stuRes.rows[0].id;
    }
  }

  // 3. Admin override via query param ?studentId=X
  const roles = req.user.roles || [];
  if ((roles.includes("school_admin") || roles.includes("admin")) && req.query.studentId) {
    return req.query.studentId;
  }

  return null;
}

// Helper: Resolve parentId for current logged-in user
async function resolveCurrentParentId(req) {
  const tenantId = tenantIdOf(req);
  const userId = req.user.id;

  const linkRes = await pool.query(
    `SELECT parent_id FROM parent_users WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId]
  );
  if (linkRes.rowCount > 0) {
    return linkRes.rows[0].parent_id;
  }

  // Match via email in parents table
  const userRes = await pool.query(
    `SELECT email FROM users WHERE tenant_id = $1 AND id = $2`,
    [tenantId, userId]
  );
  if (userRes.rowCount > 0) {
    const email = userRes.rows[0].email;
    const parentRes = await pool.query(
      `SELECT id FROM parents WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email]
    );
    if (parentRes.rowCount > 0) {
      return parentRes.rows[0].id;
    }
  }

  return null;
}

/* ==========================================================================
   PORTAL ACCOUNT LINKING
   ========================================================================== */

// POST /api/portal/link-student
// Link a user account to a student record
router.post("/link-student", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { userId, studentId } = req.body;

  if (!isPositiveId(userId) || !isPositiveId(studentId)) {
    return res.status(400).json({
      success: false,
      message: "Valid userId and studentId are required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO student_users (tenant_id, user_id, student_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id)
       DO UPDATE SET student_id = EXCLUDED.student_id
       RETURNING *`,
      [tenantId, userId, studentId]
    );

    await logAudit(req, {
      action: "UPDATE",
      entityType: "student_user_link",
      entityId: studentId,
      details: { userId, studentId },
    });

    res.json({
      success: true,
      message: "Student linked to user account successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/portal/link-parent
// Link a user account to a parent record
router.post("/link-parent", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { userId, parentId } = req.body;

  if (!isPositiveId(userId) || !isPositiveId(parentId)) {
    return res.status(400).json({
      success: false,
      message: "Valid userId and parentId are required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO parent_users (tenant_id, user_id, parent_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id, parent_id) DO NOTHING
       RETURNING *`,
      [tenantId, userId, parentId]
    );

    await logAudit(req, {
      action: "UPDATE",
      entityType: "parent_user_link",
      entityId: parentId,
      details: { userId, parentId },
    });

    res.json({
      success: true,
      message: "Parent linked to user account successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   STUDENT PORTAL ENDPOINTS
   ========================================================================== */

// GET /api/portal/student/profile
// 360-degree student profile overview
router.get("/student/profile", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const studentId = await resolveCurrentStudentId(req);
    if (!studentId) {
      return res.status(404).json({
        success: false,
        message: "No student profile associated with this account.",
      });
    }

    const studentResult = await pool.query(
      `SELECT * FROM students WHERE tenant_id = $1 AND id = $2`,
      [tenantId, studentId]
    );

    if (studentResult.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Student record not found." });
    }

    const student = studentResult.rows[0];

    // Attendance summary
    const attendanceRes = await pool.query(
      `SELECT
         COUNT(*) AS total_days,
         COUNT(*) FILTER (WHERE status = 'present') AS present_days,
         COUNT(*) FILTER (WHERE status = 'absent') AS absent_days,
         COUNT(*) FILTER (WHERE status = 'late') AS late_days,
         ROUND(
           (COUNT(*) FILTER (WHERE status = 'present')::numeric / NULLIF(COUNT(*), 0)) * 100,
           1
         ) AS attendance_percentage
       FROM student_attendance
       WHERE tenant_id = $1 AND student_id = $2`,
      [tenantId, studentId]
    );

    // Fee summary
    const feeRes = await pool.query(
      `SELECT
         COALESCE(SUM(sfa.amount_paise), 0) AS total_assigned_paise,
         (SELECT COALESCE(SUM(fp.amount_paise), 0) FROM fee_payments fp JOIN student_fee_assignments a ON a.id = fp.assignment_id WHERE a.tenant_id = $1 AND a.student_id = $2) AS total_paid_paise
       FROM student_fee_assignments sfa
       WHERE sfa.tenant_id = $1 AND sfa.student_id = $2`,
      [tenantId, studentId]
    );

    const totalAssigned = Number(feeRes.rows[0].total_assigned_paise);
    const totalPaid = Number(feeRes.rows[0].total_paid_paise);
    const dueAmount = Math.max(0, totalAssigned - totalPaid);

    // Parent contact
    const parentRes = await pool.query(
      `SELECT full_name, relationship, phone, email
       FROM parents
       WHERE tenant_id = $1 AND student_id = $2
       LIMIT 1`,
      [tenantId, studentId]
    );

    res.json({
      success: true,
      data: {
        profile: student,
        attendance: attendanceRes.rows[0],
        fees: {
          totalAssignedPaise: totalAssigned,
          totalPaidPaise: totalPaid,
          duePaise: dueAmount,
        },
        guardian: parentRes.rows[0] || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/portal/student/attendance
// Full attendance records for student
router.get("/student/attendance", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const studentId = await resolveCurrentStudentId(req);
    if (!studentId) {
      return res.status(404).json({ success: false, message: "No student profile found." });
    }

    const { month, year } = req.query;
    const conditions = ["tenant_id = $1", "student_id = $2"];
    const params = [tenantId, studentId];
    let paramIndex = 3;

    if (month && year) {
      conditions.push(`TO_CHAR(attendance_date, 'YYYY-MM') = $${paramIndex}`);
      params.push(`${year}-${String(month).padStart(2, "0")}`);
      paramIndex++;
    }

    const historyResult = await pool.query(
      `SELECT attendance_date::text AS date, status, remarks
       FROM student_attendance
       WHERE ${conditions.join(" AND ")}
       ORDER BY attendance_date DESC`,
      params
    );

    res.json({
      success: true,
      count: historyResult.rowCount,
      data: historyResult.rows,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/portal/student/exams
// Student's exam marks and report card
router.get("/student/exams", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const studentId = await resolveCurrentStudentId(req);
    if (!studentId) {
      return res.status(404).json({ success: false, message: "No student profile found." });
    }

    const marksResult = await pool.query(
      `SELECT
         em.id,
         em.marks_obtained,
         em.is_absent,
         em.remarks,
         e.name AS exam_name,
         e.academic_year,
         sub.name AS subject_name,
         es.max_marks,
         es.passing_marks,
         es.exam_date
       FROM exam_marks em
       JOIN exam_schedules es ON es.tenant_id = em.tenant_id AND es.id = em.exam_schedule_id
       JOIN examinations e ON e.tenant_id = es.tenant_id AND e.id = es.examination_id
       JOIN school_subjects sub ON sub.tenant_id = es.tenant_id AND sub.id = es.subject_id
       WHERE em.tenant_id = $1 AND em.student_id = $2
       ORDER BY es.exam_date DESC`,
      [tenantId, studentId]
    );

    res.json({
      success: true,
      data: marksResult.rows,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/portal/student/fees
// Student fee invoices and receipts
router.get("/student/fees", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const studentId = await resolveCurrentStudentId(req);
    if (!studentId) {
      return res.status(404).json({ success: false, message: "No student profile found." });
    }

    // Invoices / Fee assignments
    const assignmentsRes = await pool.query(
      `SELECT
         sfa.*,
         fc.name AS category_name,
         fs.due_date
       FROM student_fee_assignments sfa
       LEFT JOIN fee_structures fs ON fs.tenant_id = sfa.tenant_id AND fs.id = sfa.fee_structure_id
       LEFT JOIN fee_categories fc ON fc.tenant_id = sfa.tenant_id AND fc.id = fs.category_id
       WHERE sfa.tenant_id = $1 AND sfa.student_id = $2
       ORDER BY sfa.id DESC`,
      [tenantId, studentId]
    );

    // Payments / Receipts
    const paymentsRes = await pool.query(
      `SELECT fp.*
       FROM fee_payments fp
       JOIN student_fee_assignments sfa ON sfa.id = fp.assignment_id
       WHERE sfa.tenant_id = $1 AND sfa.student_id = $2
       ORDER BY fp.payment_date DESC`,
      [tenantId, studentId]
    );

    res.json({
      success: true,
      data: {
        assignments: assignmentsRes.rows,
        payments: paymentsRes.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/portal/student/transport-hostel
// Student transport & hostel details
router.get("/student/transport-hostel", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const studentId = await resolveCurrentStudentId(req);
    if (!studentId) {
      return res.status(404).json({ success: false, message: "No student profile found." });
    }

    // Transport info
    const transportRes = await pool.query(
      `SELECT
         sta.*,
         tr.name AS route_name,
         tv.vehicle_number,
         tv.driver_name,
         tv.driver_phone,
         ts.name AS stop_name
       FROM student_transport_assignments sta
       JOIN transport_routes tr ON tr.tenant_id = sta.tenant_id AND tr.id = sta.route_id
       JOIN transport_vehicles tv ON tv.tenant_id = sta.tenant_id AND tv.id = sta.vehicle_id
       LEFT JOIN transport_stops ts ON ts.tenant_id = sta.tenant_id AND ts.id = sta.stop_id
       WHERE sta.tenant_id = $1 AND sta.student_id = $2 AND sta.status = 'active'`,
      [tenantId, studentId]
    );

    // Hostel info
    const hostelRes = await pool.query(
      `SELECT
         ha.*,
         h.name AS hostel_name,
         h.type AS hostel_type,
         hr.room_number,
         hr.floor_number
       FROM hostel_allocations ha
       JOIN hostel_rooms hr ON hr.tenant_id = ha.tenant_id AND hr.id = ha.room_id
       JOIN hostels h ON h.tenant_id = hr.tenant_id AND h.id = hr.hostel_id
       WHERE ha.tenant_id = $1 AND ha.student_id = $2 AND ha.status = 'active'`,
      [tenantId, studentId]
    );

    res.json({
      success: true,
      data: {
        transport: transportRes.rows[0] || null,
        hostel: hostelRes.rows[0] || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   PARENT PORTAL ENDPOINTS
   ========================================================================== */

// GET /api/portal/parent/children
// List children / wards linked to this parent
router.get("/parent/children", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const userId = req.user.id;

    // Find children linked via parent_users or parents table
    const childrenRes = await pool.query(
      `SELECT
         s.id,
         s.admission_number,
         s.first_name,
         s.last_name,
         s.date_of_birth,
         s.gender,
         s.class_name,
         s.section,
         s.roll_number,
         s.status,
         p.relationship
       FROM students s
       JOIN parents p ON p.tenant_id = s.tenant_id AND p.student_id = s.id
       LEFT JOIN parent_users pu ON pu.tenant_id = p.tenant_id AND pu.parent_id = p.id
       JOIN users u ON u.tenant_id = s.tenant_id AND (u.id = pu.user_id OR u.email = p.email)
       WHERE s.tenant_id = $1 AND u.id = $2
       ORDER BY s.first_name ASC`,
      [tenantId, userId]
    );

    res.json({
      success: true,
      count: childrenRes.rowCount,
      data: childrenRes.rows,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/portal/parent/children/:studentId/overview
// 360 overview of a specific child for the parent
router.get("/parent/children/:studentId/overview", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { studentId } = req.params;
  if (!isPositiveId(studentId)) {
    return res.status(400).json({ success: false, message: "Invalid student ID." });
  }

  try {
    const studentRes = await pool.query(
      `SELECT * FROM students WHERE tenant_id = $1 AND id = $2`,
      [tenantId, studentId]
    );

    if (studentRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Student record not found." });
    }

    const attendanceRes = await pool.query(
      `SELECT
         COUNT(*) AS total_days,
         COUNT(*) FILTER (WHERE status = 'present') AS present_days,
         COUNT(*) FILTER (WHERE status = 'absent') AS absent_days,
         ROUND(
           (COUNT(*) FILTER (WHERE status = 'present')::numeric / NULLIF(COUNT(*), 0)) * 100,
           1
         ) AS attendance_percentage
       FROM student_attendance
       WHERE tenant_id = $1 AND student_id = $2`,
      [tenantId, studentId]
    );

    const feeRes = await pool.query(
      `SELECT
         COALESCE(SUM(sfa.amount_paise), 0) AS total_assigned_paise,
         (SELECT COALESCE(SUM(fp.amount_paise), 0) FROM fee_payments fp JOIN student_fee_assignments a ON a.id = fp.assignment_id WHERE a.tenant_id = $1 AND a.student_id = $2) AS total_paid_paise
       FROM student_fee_assignments sfa
       WHERE sfa.tenant_id = $1 AND sfa.student_id = $2`,
      [tenantId, studentId]
    );

    const billed = Number(feeRes.rows[0].total_assigned_paise);
    const paid = Number(feeRes.rows[0].total_paid_paise);

    res.json({
      success: true,
      data: {
        student: studentRes.rows[0],
        attendance: attendanceRes.rows[0],
        fees: {
          totalBilledPaise: billed,
          totalPaidPaise: paid,
          duePaise: Math.max(0, billed - paid),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/portal/parent/children/:studentId/leave
// Parent submits student leave application
router.post("/parent/children/:studentId/leave", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { studentId } = req.params;
  const { fromDate, toDate, reason } = req.body;

  if (!fromDate || !toDate || !reason || !reason.trim()) {
    return res.status(400).json({
      success: false,
      message: "fromDate, toDate, and reason are required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO student_leave_requests (
         tenant_id,
         student_id,
         from_date,
         to_date,
         reason,
         status,
         submitted_by_role,
         submitted_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, 'pending', 'parent', $6)
       RETURNING *`,
      [
        tenantId,
        studentId,
        fromDate,
        toDate,
        reason.trim(),
        req.user.id,
      ]
    );

    await logAudit(req, {
      action: "CREATE",
      entityType: "student_leave_request",
      entityId: result.rows[0].id,
      details: { studentId, fromDate, toDate },
    });

    res.status(201).json({
      success: true,
      message: "Leave application submitted successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/portal/parent/children/:studentId/leave
// List leave applications for a child
router.get("/parent/children/:studentId/leave", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { studentId } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM student_leave_requests
       WHERE tenant_id = $1 AND student_id = $2
       ORDER BY created_at DESC`,
      [tenantId, studentId]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
