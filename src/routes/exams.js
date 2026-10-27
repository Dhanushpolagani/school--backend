const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();

router.use(authenticateToken);

function isValidId(value) {
  return /^[1-9]\d*$/.test(String(value));
}

// -------------------------------------------------------------
// EXAMINATIONS
// -------------------------------------------------------------

// GET /api/exams
router.get("/", async (req, res, next) => {
  try {
    const { status, academicYear } = req.query;
    let query = `
      SELECT e.id, e.name, e.academic_year, e.term, e.start_date, e.end_date, e.status, e.created_at,
             COUNT(es.id)::INTEGER AS schedules_count
      FROM examinations e
      LEFT JOIN exam_schedules es ON es.examination_id = e.id AND es.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1
    `;
    const params = [req.user.tenantId];

    if (status) {
      query += ` AND e.status = $${params.length + 1}`;
      params.push(status);
    }
    if (academicYear) {
      query += ` AND e.academic_year = $${params.length + 1}`;
      params.push(academicYear);
    }

    query += " GROUP BY e.id ORDER BY e.start_date DESC";

    const result = await pool.query(query, params);

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/exams
router.post("/", async (req, res, next) => {
  const { name, academicYear, term, startDate, endDate, status = "draft" } = req.body || {};

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ success: false, message: "Exam name is required." });
  }

  if (!academicYear || !/^[0-9]{4}-[0-9]{4}$/.test(academicYear)) {
    return res.status(400).json({ success: false, message: "Valid academicYear (e.g. 2026-2027) is required." });
  }

  if (!startDate || !endDate) {
    return res.status(400).json({ success: false, message: "Start date and end date are required." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO examinations (tenant_id, name, academic_year, term, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, academic_year, term, start_date, end_date, status, created_at`,
      [req.user.tenantId, name.trim(), academicYear, term || null, startDate, endDate, status]
    );

    await logAudit(req, {
      action: "CREATE",
      entity: "EXAM",
      entityId: String(result.rows[0].id),
      details: { name, academicYear },
    });

    return res.status(201).json({
      success: true,
      message: "Examination created successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "An exam with this name already exists for this academic year." });
    }
    next(error);
  }
});

// GET /api/exams/:id
router.get("/:id", async (req, res, next) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid exam ID." });

  try {
    const examRes = await pool.query(
      "SELECT * FROM examinations WHERE id = $1 AND tenant_id = $2",
      [id, req.user.tenantId]
    );

    if (examRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Examination not found." });
    }

    const schedulesRes = await pool.query(
      `SELECT es.*, s.name AS subject_name, s.subject_code, c.name AS class_name, sec.name AS section_name
       FROM exam_schedules es
       JOIN school_subjects s ON s.id = es.subject_id AND s.tenant_id = es.tenant_id
       JOIN school_classes c ON c.id = es.class_id AND c.tenant_id = es.tenant_id
       LEFT JOIN class_sections sec ON sec.id = es.section_id AND sec.tenant_id = es.tenant_id
       WHERE es.examination_id = $1 AND es.tenant_id = $2
       ORDER BY es.exam_date, es.start_time`,
      [id, req.user.tenantId]
    );

    return res.json({
      success: true,
      data: {
        ...examRes.rows[0],
        schedules: schedulesRes.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/exams/:id/schedules
router.post("/:id/schedules", async (req, res, next) => {
  const { id } = req.params;
  const { subjectId, classId, sectionId, examDate, startTime, durationMinutes = 180, maxMarks = 100, passMarks = 40 } = req.body || {};

  if (!isValidId(id) || !isValidId(subjectId) || !isValidId(classId)) {
    return res.status(400).json({ success: false, message: "Valid exam ID, subject ID, and class ID are required." });
  }

  if (!examDate || !startTime) {
    return res.status(400).json({ success: false, message: "Exam date and start time are required." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO exam_schedules (
         tenant_id, examination_id, subject_id, class_id, section_id,
         exam_date, start_time, duration_minutes, max_marks, pass_marks
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        req.user.tenantId, id, subjectId, classId, sectionId || null,
        examDate, startTime, durationMinutes, maxMarks, passMarks
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Exam paper scheduled successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/exams/marks
router.post("/marks", async (req, res, next) => {
  const { examScheduleId, studentId, marksObtained, isAbsent = false, remarks } = req.body || {};

  if (!isValidId(examScheduleId) || !isValidId(studentId)) {
    return res.status(400).json({ success: false, message: "Valid examScheduleId and studentId are required." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO exam_marks (tenant_id, exam_schedule_id, student_id, marks_obtained, is_absent, remarks)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, exam_schedule_id, student_id)
       DO UPDATE SET marks_obtained = EXCLUDED.marks_obtained,
                     is_absent = EXCLUDED.is_absent,
                     remarks = EXCLUDED.remarks,
                     updated_at = NOW()
       RETURNING *`,
      [req.user.tenantId, examScheduleId, studentId, isAbsent ? null : marksObtained, Boolean(isAbsent), remarks || null]
    );

    return res.status(200).json({
      success: true,
      message: "Marks recorded successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/exams/schedules/:scheduleId/marks
router.get("/schedules/:scheduleId/marks", async (req, res, next) => {
  const { scheduleId } = req.params;

  if (!isValidId(scheduleId)) {
    return res.status(400).json({ success: false, message: "Invalid schedule ID." });
  }

  try {
    const result = await pool.query(
      `SELECT em.*, s.first_name, s.last_name, s.admission_number, s.roll_number
       FROM exam_marks em
       JOIN students s ON s.id = em.student_id AND s.tenant_id = em.tenant_id
       WHERE em.exam_schedule_id = $1 AND em.tenant_id = $2
       ORDER BY s.roll_number, s.first_name`,
      [scheduleId, req.user.tenantId]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
