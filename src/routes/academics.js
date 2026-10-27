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
// CLASSES
// -------------------------------------------------------------

// POST /api/academics/classes or /api/classes
// Create a class for the authenticated school.
router.post(["/", "/classes"], async (req, res, next) => {
  const { name, description } = req.body || {};

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Class name is required.",
    });
  }

  if (
    description !== undefined &&
    description !== null &&
    typeof description !== "string"
  ) {
    return res.status(400).json({
      success: false,
      message: "Description must be text or null.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO school_classes (
         tenant_id,
         name,
         description
       )
       VALUES ($1, $2, $3)
       RETURNING
         id,
         tenant_id,
         name,
         description,
         status,
         created_at`,
      [
        req.user.tenantId,
        name.trim(),
        description?.trim() || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Class created successfully.",
      class: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A class with this name already exists in your school.",
      });
    }

    next(error);
  }
});

// GET /api/academics/classes or /api/classes
// List classes belonging to the authenticated school.
router.get(["/", "/classes"], async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         c.id,
         c.name,
         c.description,
         c.status,
         c.created_at,
         COUNT(s.id)::INTEGER AS section_count
       FROM school_classes c
       LEFT JOIN class_sections s
         ON s.class_id = c.id
        AND s.tenant_id = c.tenant_id
       WHERE c.tenant_id = $1
       GROUP BY c.id
       ORDER BY c.name`,
      [req.user.tenantId]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      classes: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// SECTIONS
// -------------------------------------------------------------

// POST /api/academics/classes/:classId/sections or /api/classes/:classId/sections
router.post(["/:classId/sections", "/classes/:classId/sections"], async (req, res, next) => {
  const { classId } = req.params;
  const { name } = req.body || {};

  if (!isValidId(classId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid class ID.",
    });
  }

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Section name is required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO class_sections (
         tenant_id,
         class_id,
         name
       )
       SELECT
         c.tenant_id,
         c.id,
         $3
       FROM school_classes c
       WHERE c.id = $1
         AND c.tenant_id = $2
       RETURNING id, class_id, name, created_at`,
      [classId, req.user.tenantId, name.trim()]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Class not found.",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Section created successfully.",
      section: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This section already exists in the selected class.",
      });
    }

    next(error);
  }
});

// GET /api/academics/classes/:classId/sections or /api/classes/:classId/sections
router.get(["/:classId/sections", "/classes/:classId/sections"], async (req, res, next) => {
  const { classId } = req.params;

  if (!isValidId(classId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid class ID.",
    });
  }

  try {
    const classResult = await pool.query(
      `SELECT id, name, status
       FROM school_classes
       WHERE id = $1 AND tenant_id = $2`,
      [classId, req.user.tenantId]
    );

    if (classResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Class not found.",
      });
    }

    const result = await pool.query(
      `SELECT id, class_id, name, created_at
       FROM class_sections
       WHERE class_id = $1 AND tenant_id = $2
       ORDER BY name`,
      [classId, req.user.tenantId]
    );

    return res.json({
      success: true,
      class: classResult.rows[0],
      count: result.rowCount,
      sections: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// SUBJECTS
// -------------------------------------------------------------

// GET /api/academics/subjects
router.get("/subjects", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, subject_code, name, description, is_active, created_at
       FROM school_subjects
       WHERE tenant_id = $1
       ORDER BY name`,
      [req.user.tenantId]
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

// POST /api/academics/subjects
router.post("/subjects", async (req, res, next) => {
  const { subjectCode, name, description } = req.body || {};

  if (!subjectCode || typeof subjectCode !== "string" || !subjectCode.trim()) {
    return res.status(400).json({ success: false, message: "Subject code is required." });
  }

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ success: false, message: "Subject name is required." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO school_subjects (tenant_id, subject_code, name, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, subject_code, name, description, is_active, created_at`,
      [req.user.tenantId, subjectCode.trim().toUpperCase(), name.trim(), description?.trim() || null]
    );

    return res.status(201).json({
      success: true,
      message: "Subject created successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A subject with this code or name already exists.",
      });
    }
    next(error);
  }
});

// PUT /api/academics/subjects/:id
router.put("/subjects/:id", async (req, res, next) => {
  const { id } = req.params;
  const { name, description, isActive } = req.body || {};

  if (!isValidId(id)) {
    return res.status(400).json({ success: false, message: "Invalid subject ID." });
  }

  try {
    const existing = await pool.query(
      "SELECT * FROM school_subjects WHERE id = $1 AND tenant_id = $2",
      [id, req.user.tenantId]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Subject not found." });
    }

    const updatedName = typeof name === "string" && name.trim() ? name.trim() : existing.rows[0].name;
    const updatedDesc = description !== undefined ? description : existing.rows[0].description;
    const updatedActive = typeof isActive === "boolean" ? isActive : existing.rows[0].is_active;

    const result = await pool.query(
      `UPDATE school_subjects
       SET name = $1, description = $2, is_active = $3, updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5
       RETURNING id, subject_code, name, description, is_active, updated_at`,
      [updatedName, updatedDesc, updatedActive, id, req.user.tenantId]
    );

    return res.json({
      success: true,
      message: "Subject updated successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
