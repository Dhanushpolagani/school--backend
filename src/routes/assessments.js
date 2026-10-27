const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();

router.use(authenticateToken);

function tenantIdOf(req) {
  return req.user?.tenantId;
}

function isPositiveId(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0;
}

// GET /api/assessments or /api/lms/assessments
// List all online assessments
router.get("/", async (req, res, next) => {
  const tenantId = tenantIdOf(req);
  if (!tenantId) {
    return res.status(401).json({ success: false, message: "Tenant authentication required." });
  }

  try {
    const { course_id, status } = req.query;
    let query = `
      SELECT a.*, c.title AS course_title,
             u.first_name AS teacher_first_name, u.last_name AS teacher_last_name,
             (SELECT COUNT(*) FROM lms_assessment_submissions s WHERE s.assessment_id = a.id) AS submission_count
      FROM lms_assessments a
      LEFT JOIN lms_courses c ON c.tenant_id = a.tenant_id AND c.id = a.course_id
      LEFT JOIN users u ON u.id = a.teacher_id
      WHERE a.tenant_id = $1
    `;
    const params = [tenantId];
    let idx = 2;

    if (course_id && isPositiveId(course_id)) {
      query += ` AND a.course_id = $${idx++}`;
      params.push(course_id);
    }
    if (status) {
      query += ` AND a.status = $${idx++}`;
      params.push(status);
    }

    query += ` ORDER BY a.id DESC`;

    const result = await pool.query(query, params);
    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
      assessments: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/assessments/:id
// Get assessment detail with questions
router.get("/:id", async (req, res, next) => {
  const tenantId = tenantIdOf(req);
  const { id } = req.params;

  if (!isPositiveId(id)) {
    return res.status(400).json({ success: false, message: "Invalid assessment ID." });
  }

  try {
    const result = await pool.query(
      `SELECT a.*, c.title AS course_title,
              u.first_name AS teacher_first_name, u.last_name AS teacher_last_name
       FROM lms_assessments a
       LEFT JOIN lms_courses c ON c.tenant_id = a.tenant_id AND c.id = a.course_id
       LEFT JOIN users u ON u.id = a.teacher_id
       WHERE a.tenant_id = $1 AND a.id = $2`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Assessment not found." });
    }

    return res.json({
      success: true,
      data: result.rows[0],
      assessment: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/assessments
// Create online assessment
router.post("/", requireRole("super_admin", "school_admin", "teacher"), async (req, res, next) => {
  const tenantId = tenantIdOf(req);
  const {
    course_id,
    title,
    description,
    total_marks = 100,
    passing_marks = 40,
    due_date,
    time_limit_mins = 60,
    questions = [],
    status = "published",
  } = req.body;

  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ success: false, message: "Assessment title is required." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO lms_assessments
         (tenant_id, course_id, title, description, teacher_id, total_marks,
          passing_marks, due_date, time_limit_mins, questions, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        tenantId,
        course_id ? Number(course_id) : null,
        title.trim(),
        description?.trim() || null,
        req.user.id ? Number(req.user.id) : null,
        parseFloat(total_marks) || 100,
        parseFloat(passing_marks) || 40,
        due_date || null,
        parseInt(time_limit_mins) || 60,
        JSON.stringify(questions),
        status || "published",
      ]
    );

    await logAudit(req, {
      action: "CREATE",
      entityType: "assessment",
      entityId: result.rows[0].id,
      details: { title },
    });

    return res.status(201).json({
      success: true,
      message: "Assessment created successfully.",
      data: result.rows[0],
      assessment: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/assessments/:id
// Update assessment
router.put("/:id", requireRole("super_admin", "school_admin", "teacher"), async (req, res, next) => {
  const tenantId = tenantIdOf(req);
  const { id } = req.params;

  if (!isPositiveId(id)) {
    return res.status(400).json({ success: false, message: "Invalid assessment ID." });
  }

  const {
    title,
    description,
    total_marks,
    passing_marks,
    due_date,
    time_limit_mins,
    questions,
    status,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE lms_assessments
       SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         total_marks = COALESCE($3, total_marks),
         passing_marks = COALESCE($4, passing_marks),
         due_date = COALESCE($5, due_date),
         time_limit_mins = COALESCE($6, time_limit_mins),
         questions = COALESCE($7, questions),
         status = COALESCE($8, status)
       WHERE tenant_id = $9 AND id = $10
       RETURNING *`,
      [
        title?.trim() || null,
        description !== undefined ? description : null,
        total_marks ? parseFloat(total_marks) : null,
        passing_marks ? parseFloat(passing_marks) : null,
        due_date || null,
        time_limit_mins ? parseInt(time_limit_mins) : null,
        questions ? JSON.stringify(questions) : null,
        status || null,
        tenantId,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Assessment not found." });
    }

    return res.json({
      success: true,
      message: "Assessment updated successfully.",
      data: result.rows[0],
      assessment: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/assessments/:id
router.delete("/:id", requireRole("super_admin", "school_admin"), async (req, res, next) => {
  const tenantId = tenantIdOf(req);
  const { id } = req.params;

  if (!isPositiveId(id)) {
    return res.status(400).json({ success: false, message: "Invalid assessment ID." });
  }

  try {
    const result = await pool.query(
      `DELETE FROM lms_assessments WHERE tenant_id = $1 AND id = $2 RETURNING id`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Assessment not found." });
    }

    return res.json({
      success: true,
      message: "Assessment deleted successfully.",
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/assessments/:id/submit
// Student submits assessment answers
router.post("/:id/submit", async (req, res, next) => {
  const tenantId = tenantIdOf(req);
  const { id } = req.params;
  const { student_id, answers } = req.body;

  if (!isPositiveId(id)) {
    return res.status(400).json({ success: false, message: "Invalid assessment ID." });
  }

  try {
    const assessRes = await pool.query(
      `SELECT * FROM lms_assessments WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id]
    );

    if (assessRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Assessment not found." });
    }

    const resolvedStudentId = student_id ? Number(student_id) : (req.user?.id ? Number(req.user.id) : null);

    const result = await pool.query(
      `INSERT INTO lms_assessment_submissions
         (tenant_id, assessment_id, student_id, answers, status, submitted_at)
       VALUES ($1, $2, $3, $4, 'submitted', NOW())
       RETURNING *`,
      [
        tenantId,
        id,
        resolvedStudentId,
        JSON.stringify(answers || {}),
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Assessment submitted successfully.",
      data: result.rows[0],
      submission: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/assessments/:id/submissions
// View student submissions for an assessment
router.get("/:id/submissions", requireRole("super_admin", "school_admin", "teacher"), async (req, res, next) => {
  const tenantId = tenantIdOf(req);
  const { id } = req.params;

  if (!isPositiveId(id)) {
    return res.status(400).json({ success: false, message: "Invalid assessment ID." });
  }

  try {
    const result = await pool.query(
      `SELECT s.*, st.first_name AS student_first_name, st.last_name AS student_last_name,
              st.student_id AS student_code
       FROM lms_assessment_submissions s
       LEFT JOIN students st ON st.tenant_id = s.tenant_id AND st.id = s.student_id
       WHERE s.tenant_id = $1 AND s.assessment_id = $2
       ORDER BY s.submitted_at DESC`,
      [tenantId, id]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
      submissions: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
