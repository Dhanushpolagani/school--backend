
const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

// POST /api/classes
// Create a class for the authenticated school.
router.post("/", async (req, res, next) => {
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

// GET /api/classes
// List classes belonging to the authenticated school.
router.get("/", async (req, res, next) => {
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

function isValidClassId(value) {
  return /^[1-9]\d*$/.test(String(value));
}

// POST /api/classes/:classId/sections
// Create a section for a class belonging to the logged-in school.
router.post("/:classId/sections", async (req, res, next) => {
  const { classId } = req.params;
  const { name } = req.body || {};

  if (!isValidClassId(classId)) {
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

// GET /api/classes/:classId/sections
// List sections for a class in the logged-in school.
router.get("/:classId/sections", async (req, res, next) => {
  const { classId } = req.params;

  if (!isValidClassId(classId)) {
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

module.exports = router;
