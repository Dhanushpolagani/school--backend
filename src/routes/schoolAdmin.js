const express = require("express");
const pool = require("../config/db");
const { verifyToken, requireRole } = require("../middleware/auth");
const { resolveTenant } = require("../middleware/tenant");
const { isValidId } = require("../utils/validators");

const router = express.Router();

router.use(verifyToken, resolveTenant);

// ---------------------------------------------------------------------------
// Academic Years
// ---------------------------------------------------------------------------
router.get("/academic-years", requireRole("super_admin", "school_admin", "admin"), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT academic_year FROM examinations WHERE tenant_id = $1 ORDER BY academic_year DESC`,
      [req.tenantId]
    );

    const years = result.rows.map((r, i) => ({
      id: i + 1,
      name: r.academic_year,
      is_current: i === 0,
    }));

    if (years.length === 0) {
      years.push({ id: 1, name: "2026-2027", is_current: true });
    }

    res.json({ success: true, data: years });
  } catch (error) {
    next(error);
  }
});

router.post("/academic-years", requireRole("super_admin", "school_admin", "admin"), async (req, res, next) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false, message: "Academic year name required." });
  res.status(201).json({ success: true, data: { name, is_current: false } });
});

// ---------------------------------------------------------------------------
// Class Masters / School Classes
// ---------------------------------------------------------------------------
router.get("/class-masters", requireRole("super_admin", "school_admin", "admin", "teacher"), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.description, c.status, COUNT(s.id)::INTEGER AS section_count
       FROM school_classes c
       LEFT JOIN class_sections s ON s.class_id = c.id AND s.tenant_id = c.tenant_id
       WHERE c.tenant_id = $1
       GROUP BY c.id
       ORDER BY c.name`,
      [req.tenantId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/class-masters", requireRole("super_admin", "school_admin", "admin"), async (req, res, next) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: "Class name is required." });

  try {
    const result = await pool.query(
      `INSERT INTO school_classes (tenant_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.tenantId, name.trim(), description || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
router.get("/sections", requireRole("super_admin", "school_admin", "admin", "teacher"), async (req, res, next) => {
  try {
    const { class_id } = req.query;
    let query = `
      SELECT s.id, s.class_id, s.name, c.name AS class_name
      FROM class_sections s
      JOIN school_classes c ON c.id = s.class_id AND c.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
    `;
    const params = [req.tenantId];
    if (class_id) {
      query += ` AND s.class_id = $2`;
      params.push(class_id);
    }
    query += " ORDER BY c.name, s.name";

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/sections", requireRole("super_admin", "school_admin", "admin"), async (req, res, next) => {
  const { classId, name } = req.body;
  if (!classId || !name) return res.status(400).json({ success: false, message: "classId and name required." });

  try {
    const result = await pool.query(
      `INSERT INTO class_sections (tenant_id, class_id, name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.tenantId, classId, name.trim()]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Curriculum & Subjects
// ---------------------------------------------------------------------------
router.get("/curriculum", requireRole("super_admin", "school_admin", "admin", "teacher"), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM school_subjects WHERE tenant_id = $1 ORDER BY name`,
      [req.tenantId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/curriculum", requireRole("super_admin", "school_admin", "admin"), async (req, res, next) => {
  const { subjectCode, name, description } = req.body;
  if (!subjectCode || !name) return res.status(400).json({ success: false, message: "subjectCode and name required." });

  try {
    const result = await pool.query(
      `INSERT INTO school_subjects (tenant_id, subject_code, name, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.tenantId, subjectCode.trim().toUpperCase(), name.trim(), description || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Enrollment & Promotions
// ---------------------------------------------------------------------------
router.post("/enrollment", requireRole("super_admin", "school_admin", "admin"), async (req, res, next) => {
  const { studentId, classId, sectionId, rollNumber } = req.body;
  if (!studentId || !classId) {
    return res.status(400).json({ success: false, message: "studentId and classId required." });
  }

  try {
    const result = await pool.query(
      `UPDATE students
       SET class_id = $1, section_id = $2, roll_number = COALESCE($3, roll_number), updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5
       RETURNING *`,
      [classId, sectionId || null, rollNumber || null, studentId, req.tenantId]
    );
    res.json({ success: true, message: "Student enrolled in class successfully.", student: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/promotion", requireRole("super_admin", "school_admin", "admin"), async (req, res, next) => {
  const { studentIds, toClassId, toSectionId } = req.body;
  if (!Array.isArray(studentIds) || !toClassId) {
    return res.status(400).json({ success: false, message: "studentIds array and toClassId required." });
  }

  try {
    await pool.query(
      `UPDATE students
       SET class_id = $1, section_id = $2, updated_at = NOW()
       WHERE id = ANY($3::bigint[]) AND tenant_id = $4`,
      [toClassId, toSectionId || null, studentIds, req.tenantId]
    );
    res.json({ success: true, message: `Successfully promoted ${studentIds.length} student(s).` });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// ID Cards
// ---------------------------------------------------------------------------
router.get("/id-cards", requireRole("super_admin", "school_admin", "admin"), async (req, res, next) => {
  try {
    const { class_id } = req.query;
    let query = `
      SELECT s.id, s.student_id, s.admission_number, s.first_name, s.last_name,
             s.date_of_birth, s.blood_group, s.emergency_contact_phone,
             c.name AS class_name, sec.name AS section_name
      FROM students s
      LEFT JOIN school_classes c ON c.id = s.class_id AND c.tenant_id = s.tenant_id
      LEFT JOIN class_sections sec ON sec.id = s.section_id AND sec.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.status = 'active'
    `;
    const params = [req.tenantId];
    if (class_id) {
      query += ` AND s.class_id = $2`;
      params.push(class_id);
    }
    query += " ORDER BY c.name, s.roll_number, s.first_name";

    const result = await pool.query(query, params);
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
