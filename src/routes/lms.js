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

// Helper: resolve student id for logged-in user
async function getStudentIdForUser(req) {
  const tenantId = tenantIdOf(req);
  const linkRes = await pool.query(
    `SELECT student_id FROM student_users WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, req.user.id]
  );
  if (linkRes.rowCount > 0) return linkRes.rows[0].student_id;

  const userRes = await pool.query(
    `SELECT email FROM users WHERE tenant_id = $1 AND id = $2`,
    [tenantId, req.user.id]
  );
  if (userRes.rowCount > 0) {
    const stu = await pool.query(
      `SELECT id FROM students WHERE tenant_id = $1 AND email = $2`,
      [tenantId, userRes.rows[0].email]
    );
    if (stu.rowCount > 0) return stu.rows[0].id;
  }
  return null;
}

/* ==========================================================================
   COURSES
   ========================================================================== */

// GET /api/lms/courses
// List LMS courses with filtering
router.get("/courses", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const { classId, teacherId, status = "published", search } = req.query;

    const conditions = ["c.tenant_id = $1"];
    const params = [tenantId];
    let paramIndex = 2;

    if (status && typeof status === "string") {
      conditions.push(`c.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (classId && isPositiveId(classId)) {
      conditions.push(`c.class_id = $${paramIndex}`);
      params.push(classId);
      paramIndex++;
    }

    if (teacherId && isPositiveId(teacherId)) {
      conditions.push(`c.teacher_id = $${paramIndex}`);
      params.push(teacherId);
      paramIndex++;
    }

    if (search && typeof search === "string" && search.trim()) {
      conditions.push(`(c.title ILIKE $${paramIndex} OR c.code ILIKE $${paramIndex})`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    const query = `
      SELECT
        c.*,
        sc.name AS class_name,
        ss.name AS subject_name,
        s.first_name AS teacher_first_name,
        s.last_name AS teacher_last_name,
        (SELECT COUNT(*) FROM lms_lessons l WHERE l.course_id = c.id) AS lesson_count,
        (SELECT COUNT(*) FROM lms_assignments a WHERE a.course_id = c.id) AS assignment_count,
        (SELECT COUNT(*) FROM lms_materials m WHERE m.course_id = c.id) AS material_count
      FROM lms_courses c
      LEFT JOIN school_classes sc ON sc.tenant_id = c.tenant_id AND sc.id = c.class_id
      LEFT JOIN school_subjects ss ON ss.tenant_id = c.tenant_id AND ss.id = c.subject_id
      LEFT JOIN staff s ON s.tenant_id = c.tenant_id AND s.id = c.teacher_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY c.id DESC
    `;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/lms/courses/:id
// Get course details with lessons, materials, and assignments
router.get("/courses/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  if (!isPositiveId(id)) {
    return res.status(400).json({ success: false, message: "Invalid course ID." });
  }

  try {
    const courseRes = await pool.query(
      `SELECT
         c.*,
         sc.name AS class_name,
         ss.name AS subject_name,
         s.first_name AS teacher_first_name,
         s.last_name AS teacher_last_name
       FROM lms_courses c
       LEFT JOIN school_classes sc ON sc.tenant_id = c.tenant_id AND sc.id = c.class_id
       LEFT JOIN school_subjects ss ON ss.tenant_id = c.tenant_id AND ss.id = c.subject_id
       LEFT JOIN staff s ON s.tenant_id = c.tenant_id AND s.id = c.teacher_id
       WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, id]
    );

    if (courseRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Course not found." });
    }

    const lessonsRes = await pool.query(
      `SELECT * FROM lms_lessons WHERE tenant_id = $1 AND course_id = $2 ORDER BY lesson_number ASC`,
      [tenantId, id]
    );

    const materialsRes = await pool.query(
      `SELECT * FROM lms_materials WHERE tenant_id = $1 AND course_id = $2 ORDER BY id DESC`,
      [tenantId, id]
    );

    const assignmentsRes = await pool.query(
      `SELECT * FROM lms_assignments WHERE tenant_id = $1 AND course_id = $2 ORDER BY due_date ASC`,
      [tenantId, id]
    );

    const course = courseRes.rows[0];
    course.lessons = lessonsRes.rows;
    course.materials = materialsRes.rows;
    course.assignments = assignmentsRes.rows;

    res.json({
      success: true,
      data: course,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/lms/courses
// Create a new LMS course
router.post("/courses", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const {
    code,
    title,
    description,
    classId,
    subjectId,
    teacherId,
    academicTerm,
  } = req.body;

  if (!code || !title) {
    return res.status(400).json({
      success: false,
      message: "Course code and title are required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO lms_courses (
         tenant_id,
         code,
         title,
         description,
         class_id,
         subject_id,
         teacher_id,
         academic_term,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published')
       RETURNING *`,
      [
        tenantId,
        code.trim().toUpperCase(),
        title.trim(),
        description?.trim() || null,
        classId || null,
        subjectId || null,
        teacherId || null,
        academicTerm?.trim() || null,
      ]
    );

    await logAudit(req, {
      action: "CREATE",
      entityType: "lms_course",
      entityId: result.rows[0].id,
      details: { code, title },
    });

    res.status(201).json({
      success: true,
      message: "Course created successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A course with this code already exists.",
      });
    }
    next(error);
  }
});

// PUT /api/lms/courses/:id
// Update course details
router.put("/courses/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { title, description, classId, subjectId, teacherId, academicTerm, status } = req.body;

  try {
    const result = await pool.query(
      `UPDATE lms_courses
       SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         class_id = COALESCE($3, class_id),
         subject_id = COALESCE($4, subject_id),
         teacher_id = COALESCE($5, teacher_id),
         academic_term = COALESCE($6, academic_term),
         status = COALESCE($7, status),
         updated_at = NOW()
       WHERE tenant_id = $8 AND id = $9
       RETURNING *`,
      [
        title?.trim() || null,
        description?.trim() || null,
        classId || null,
        subjectId || null,
        teacherId || null,
        academicTerm?.trim() || null,
        status || null,
        tenantId,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Course not found." });
    }

    res.json({
      success: true,
      message: "Course updated.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   LESSONS
   ========================================================================== */

// POST /api/lms/courses/:id/lessons
// Add a lesson to a course
router.post("/courses/:id/lessons", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const {
    lessonNumber = 1,
    title,
    description,
    contentBody,
    videoUrl,
    attachmentUrl,
  } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ success: false, message: "Lesson title is required." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO lms_lessons (
         tenant_id,
         course_id,
         lesson_number,
         title,
         description,
         content_body,
         video_url,
         attachment_url,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published')
       RETURNING *`,
      [
        tenantId,
        id,
        parseInt(lessonNumber, 10) || 1,
        title.trim(),
        description?.trim() || null,
        contentBody || null,
        videoUrl?.trim() || null,
        attachmentUrl?.trim() || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Lesson added successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/lms/lessons/:id
// Delete a lesson
router.delete("/lessons/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM lms_lessons WHERE tenant_id = $1 AND id = $2 RETURNING id`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Lesson not found." });
    }

    res.json({ success: true, message: "Lesson deleted." });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   MATERIALS / RESOURCES
   ========================================================================== */

// POST /api/lms/courses/:id/materials
// Add learning material to course
router.post("/courses/:id/materials", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { title, materialType = "document", fileUrl, description } = req.body;

  if (!title || !fileUrl) {
    return res.status(400).json({
      success: false,
      message: "Material title and fileUrl are required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO lms_materials (
         tenant_id,
         course_id,
         title,
         material_type,
         file_url,
         description
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        tenantId,
        id,
        title.trim(),
        materialType,
        fileUrl.trim(),
        description?.trim() || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Material uploaded successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/lms/materials/:id
// Delete a learning resource
router.delete("/materials/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM lms_materials WHERE tenant_id = $1 AND id = $2 RETURNING id`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Material not found." });
    }

    res.json({ success: true, message: "Material removed." });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   ASSIGNMENTS & SUBMISSIONS
   ========================================================================== */

// GET /api/lms/assignments
// List assignments
router.get("/assignments", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const { courseId, status = "published" } = req.query;

    const conditions = ["a.tenant_id = $1"];
    const params = [tenantId];
    let paramIndex = 2;

    if (courseId && isPositiveId(courseId)) {
      conditions.push(`a.course_id = $${paramIndex}`);
      params.push(courseId);
      paramIndex++;
    }

    if (status && typeof status === "string") {
      conditions.push(`a.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    const result = await pool.query(
      `SELECT
         a.*,
         c.title AS course_title,
         c.code AS course_code,
         (SELECT COUNT(*) FROM lms_submissions sub WHERE sub.assignment_id = a.id) AS submission_count
       FROM lms_assignments a
       JOIN lms_courses c ON c.tenant_id = a.tenant_id AND c.id = a.course_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY a.due_date ASC`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/lms/assignments
// Create assignment for a course
router.post("/assignments", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const {
    courseId,
    title,
    description,
    dueDate,
    maxMarks = 100,
    attachmentUrl,
  } = req.body;

  if (!courseId || !title || !dueDate) {
    return res.status(400).json({
      success: false,
      message: "courseId, title, and dueDate are required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO lms_assignments (
         tenant_id,
         course_id,
         title,
         description,
         due_date,
         max_marks,
         attachment_url,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'published')
       RETURNING *`,
      [
        tenantId,
        courseId,
        title.trim(),
        description?.trim() || null,
        dueDate,
        parseFloat(maxMarks) || 100,
        attachmentUrl?.trim() || null,
      ]
    );

    await logAudit(req, {
      action: "CREATE",
      entityType: "lms_assignment",
      entityId: result.rows[0].id,
      details: { courseId, title, dueDate },
    });

    res.status(201).json({
      success: true,
      message: "Assignment created successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/lms/assignments/:id
// Get assignment details + all submissions
router.get("/assignments/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const assgnRes = await pool.query(
      `SELECT
         a.*,
         c.title AS course_title,
         c.code AS course_code
       FROM lms_assignments a
       JOIN lms_courses c ON c.tenant_id = a.tenant_id AND c.id = a.course_id
       WHERE a.tenant_id = $1 AND a.id = $2`,
      [tenantId, id]
    );

    if (assgnRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Assignment not found." });
    }

    const subsRes = await pool.query(
      `SELECT
         sub.*,
         s.admission_number,
         s.first_name,
         s.last_name,
         s.class_name,
         s.section,
         s.roll_number
       FROM lms_submissions sub
       JOIN students s ON s.tenant_id = sub.tenant_id AND s.id = sub.student_id
       WHERE sub.tenant_id = $1 AND sub.assignment_id = $2
       ORDER BY sub.submitted_at DESC`,
      [tenantId, id]
    );

    const assignment = assgnRes.rows[0];
    assignment.submissions = subsRes.rows;

    res.json({
      success: true,
      data: assignment,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/lms/assignments/:id/submit
// Student submits work for an assignment
router.post("/assignments/:id/submit", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { submissionText, attachmentUrl } = req.body;

  try {
    const studentId = await getStudentIdForUser(req);
    if (!studentId) {
      return res.status(403).json({
        success: false,
        message: "Only logged-in students can submit assignments.",
      });
    }

    // Check assignment due date
    const assgnRes = await pool.query(
      `SELECT due_date FROM lms_assignments WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id]
    );

    if (assgnRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Assignment not found." });
    }

    const dueDate = new Date(assgnRes.rows[0].due_date);
    const isLate = new Date() > dueDate;

    const result = await pool.query(
      `INSERT INTO lms_submissions (
         tenant_id,
         assignment_id,
         student_id,
         submission_text,
         attachment_url,
         status,
         submitted_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (tenant_id, assignment_id, student_id)
       DO UPDATE SET
         submission_text = EXCLUDED.submission_text,
         attachment_url = EXCLUDED.attachment_url,
         status = 'resubmitted',
         submitted_at = NOW()
       RETURNING *`,
      [
        tenantId,
        id,
        studentId,
        submissionText?.trim() || null,
        attachmentUrl?.trim() || null,
        isLate ? "late" : "submitted",
      ]
    );

    await logAudit(req, {
      action: "CREATE",
      entityType: "lms_submission",
      entityId: result.rows[0].id,
      details: { assignmentId: id, studentId, isLate },
    });

    res.json({
      success: true,
      message: "Assignment submitted successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/lms/submissions/:id/grade
// Teacher grades student submission
router.post("/submissions/:id/grade", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { marksObtained, feedback } = req.body;

  if (marksObtained === undefined || Number(marksObtained) < 0) {
    return res.status(400).json({
      success: false,
      message: "Valid non-negative marksObtained is required.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE lms_submissions
       SET
         marks_obtained = $1,
         feedback = $2,
         status = 'graded',
         graded_by = $3,
         graded_at = NOW()
       WHERE tenant_id = $4 AND id = $5
       RETURNING *`,
      [
        parseFloat(marksObtained),
        feedback?.trim() || null,
        req.user?.id ? Number(req.user.id) : null,
        tenantId,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Submission not found." });
    }

    await logAudit(req, {
      action: "UPDATE",
      entityType: "lms_grade",
      entityId: id,
      details: { marksObtained, feedback },
    });

    res.json({
      success: true,
      message: "Submission graded successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/lms/my-courses
// Courses for the logged-in student or teacher
router.get("/my-courses", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const studentId = await getStudentIdForUser(req);

    if (studentId) {
      // Find courses for student's class
      const stuRes = await pool.query(
        `SELECT class_name FROM students WHERE tenant_id = $1 AND id = $2`,
        [tenantId, studentId]
      );

      const className = stuRes.rows[0]?.class_name;
      const coursesRes = await pool.query(
        `SELECT c.*, sc.name AS class_name, ss.name AS subject_name
         FROM lms_courses c
         LEFT JOIN school_classes sc ON sc.tenant_id = c.tenant_id AND sc.id = c.class_id
         LEFT JOIN school_subjects ss ON ss.tenant_id = c.tenant_id AND ss.id = c.subject_id
         WHERE c.tenant_id = $1 AND (sc.name ILIKE $2 OR c.class_id IS NULL)
         ORDER BY c.title ASC`,
        [tenantId, `%${className || ""}%`]
      );

      return res.json({ success: true, data: coursesRes.rows });
    }

    // Default: list all published courses
    const allCourses = await pool.query(
      `SELECT * FROM lms_courses WHERE tenant_id = $1 AND status = 'published'`,
      [tenantId]
    );

    res.json({ success: true, data: allCourses.rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
