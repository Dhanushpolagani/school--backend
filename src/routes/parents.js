
const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router({ mergeParams: true });
// Every parent endpoint requires a valid login.
router.use(authenticateToken);

function isValidId(value) {
  return /^[1-9]\d*$/.test(String(value));
}

function isOptionalString(value) {
  return value === undefined || value === null ||
    typeof value === "string";
}

// GET /api/students/:studentId/parents
// Return parents belonging to a student in the logged-in school.
router.get("/", async (req, res, next) => {
  const { studentId } = req.params;

  if (!isValidId(studentId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID.",
    });
  }
  

  try {
    const studentResult = await pool.query(
      `SELECT id
       FROM students
       WHERE id = $1 AND tenant_id = $2`,
      [studentId, req.user.tenantId]
    );

    if (studentResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    const result = await pool.query(
      `SELECT
         id,
         student_id,
         full_name,
         relationship,
         phone,
         email,
         occupation,
         address,
         created_at
       FROM parents
       WHERE student_id = $1 AND tenant_id = $2
       ORDER BY id`,
      [studentId, req.user.tenantId]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      parents: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/students/:studentId/parents
// Add a parent or guardian to a student in the logged-in school.
router.post("/", async (req, res, next) => {
  const { studentId } = req.params;
  const {
    fullName,
    relationship,
    phone,
    email,
    occupation,
    address,
  } = req.body;

  if (!isValidId(studentId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID.",
    });
  }

  if (
    typeof fullName !== "string" ||
    !fullName.trim() ||
    typeof relationship !== "string" ||
    !relationship.trim() ||
    typeof phone !== "string" ||
    !phone.trim()
  ) {
    return res.status(400).json({
      success: false,
      message: "Full name, relationship, and phone are required.",
    });
  }

  if (
    ![
      email,
      occupation,
      address,
    ].every(isOptionalString)
  ) {
    return res.status(400).json({
      success: false,
      message: "Email, occupation, and address must be text values.",
    });
  }

  const normalizedRelationship = relationship.trim().toLowerCase();
  const allowedRelationships = [
    "father",
    "mother",
    "guardian",
    "other",
  ];

  if (!allowedRelationships.includes(normalizedRelationship)) {
    return res.status(400).json({
      success: false,
      message: "Relationship must be father, mother, guardian, or other.",
    });
  }

  try {
    // Derive tenant_id from the student record.
    // This prevents a request from assigning a parent to another school.
    const result = await pool.query(
      `INSERT INTO parents (
         tenant_id,
         student_id,
         full_name,
         relationship,
         phone,
         email,
         occupation,
         address
       )
       SELECT
         s.tenant_id,
         s.id,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8
       FROM students s
       WHERE s.id = $1 AND s.tenant_id = $2
       RETURNING
         id,
         student_id,
         full_name,
         relationship,
         phone,
         email,
         occupation,
         address,
         created_at`,
      [
        studentId,
        req.user.tenantId,
        fullName.trim(),
        normalizedRelationship,
        phone.trim(),
        email?.trim() || null,
        occupation?.trim() || null,
        address?.trim() || null,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Parent or guardian added successfully.",
      parent: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
