
const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const parentsRoutes = require("./parents");
const router = express.Router({ mergeParams: true });
// All student endpoints require authentication.
router.use(authenticateToken);
router.use("/:studentId/parents", parentsRoutes);

// GET /api/students
// List students belonging to the logged-in school.
router.get("/", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         admission_number,
         first_name,
         last_name,
         date_of_birth,
         gender,
         class_name,
         section,
         roll_number,
         email,
         phone,
         address,
         status,
         created_at
       FROM students
       WHERE tenant_id = $1
       ORDER BY id DESC`,
      [req.user.tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      students: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/students
// Create a student in the logged-in school.
router.post("/", async (req, res, next) => {
  try {
    const {
      admissionNumber,
      firstName,
      lastName,
      dateOfBirth,
      gender,
      className,
      section,
      rollNumber,
      email,
      phone,
      address,
    } = req.body;

    if (
      typeof admissionNumber !== "string" ||
      !admissionNumber.trim() ||
      typeof firstName !== "string" ||
      !firstName.trim() ||
      typeof className !== "string" ||
      !className.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Admission number, first name, and class are required.",
      });
    }

    const optionalStrings = [
      lastName,
      gender,
      section,
      rollNumber,
      email,
      phone,
      address,
    ];

    if (optionalStrings.some(
      (value) => value !== undefined && value !== null &&
        typeof value !== "string"
    )) {
      return res.status(400).json({
        success: false,
        message: "Optional text fields must be strings.",
      });
    }

    if (
      dateOfBirth !== undefined &&
      dateOfBirth !== null &&
      (
        typeof dateOfBirth !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) ||
        !Number.isFinite(Date.parse(`${dateOfBirth}T00:00:00Z`)) ||
        new Date(`${dateOfBirth}T00:00:00Z`).toISOString().slice(0, 10) !== dateOfBirth
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Date of birth must be a valid date in YYYY-MM-DD format.",
      });
    }

    const allowedGenders = ["male", "female", "other"];
    if (
      gender !== undefined &&
      gender !== null &&
      !allowedGenders.includes(gender.toLowerCase())
    ) {
      return res.status(400).json({
        success: false,
        message: "Gender must be male, female, or other.",
      });
    }

    const result = await pool.query(
      `INSERT INTO students (
         tenant_id,
         admission_number,
         first_name,
         last_name,
         date_of_birth,
         gender,
         class_name,
         section,
         roll_number,
         email,
         phone,
         address
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING
         id,
         admission_number,
         first_name,
         last_name,
         date_of_birth,
         gender,
         class_name,
         section,
         roll_number,
         email,
         phone,
         address,
         status,
         created_at`,
      [
        req.user.tenantId,
        admissionNumber.trim(),
        firstName.trim(),
        lastName?.trim() || null,
        dateOfBirth || null,
        gender?.toLowerCase() || null,
        className.trim(),
        section?.trim() || null,
        rollNumber?.trim() || null,
        email?.trim() || null,
        phone?.trim() || null,
        address?.trim() || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Student created successfully.",
      student: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This admission number already exists for this school.",
      });
    }

    next(error);
  }
});

function isValidStudentId(value) {
  return /^[1-9]\d*$/.test(String(value));
}

router.get("/:id", async (req, res, next) => {
  const { id } = req.params;

  if (!isValidStudentId(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT *
       FROM students
       WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    return res.json({
      success: true,
      student: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});


const editableStudentFields = {
  admissionNumber: "admission_number",
  firstName: "first_name",
  lastName: "last_name",
  dateOfBirth: "date_of_birth",
  gender: "gender",
  className: "class_name",
  section: "section",
  rollNumber: "roll_number",
  email: "email",
  phone: "phone",
  address: "address",
};

router.put("/:id", async (req, res, next) => {
  const { id } = req.params;
  const body = req.body;

  if (!isValidStudentId(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID.",
    });
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return res.status(400).json({
      success: false,
      message: "Request body must be a JSON object.",
    });
  }

  const keys = Object.keys(body);

  if (keys.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one field to update.",
    });
  }

  const unknownFields = keys.filter(
    (key) => !Object.hasOwn(editableStudentFields, key)
  );

  if (unknownFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: "Unsupported field(s): " + unknownFields.join(", "),
    });
  }

  for (const field of ["admissionNumber", "firstName", "className"]) {
    if (
      Object.hasOwn(body, field) &&
      (
        typeof body[field] !== "string" ||
        !body[field].trim()
      )
    ) {
      return res.status(400).json({
        success: false,
        message: `${field} must be a non-empty string.`,
      });
    }
  }

  const optionalTextFields = [
    "lastName", "gender", "section", "rollNumber",
    "email", "phone", "address",
  ];

  for (const field of optionalTextFields) {
    if (
      Object.hasOwn(body, field) &&
      body[field] !== null &&
      typeof body[field] !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: `${field} must be text or null.`,
      });
    }
  }

  if (
    Object.hasOwn(body, "dateOfBirth") &&
    body.dateOfBirth !== null &&
    (
      typeof body.dateOfBirth !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.dateOfBirth) ||
      !Number.isFinite(Date.parse(`${body.dateOfBirth}T00:00:00Z`)) ||
      new Date(`${body.dateOfBirth}T00:00:00Z`)
        .toISOString().slice(0, 10) !== body.dateOfBirth
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "dateOfBirth must be a valid YYYY-MM-DD date or null.",
    });
  }

  if (
    Object.hasOwn(body, "gender") &&
    body.gender !== null &&
    !["male", "female", "other"].includes(body.gender.toLowerCase())
  ) {
    return res.status(400).json({
      success: false,
      message: "Gender must be male, female, other, or null.",
    });
  }

  try {
    const values = [id, req.user.tenantId];
    const assignments = [];

    for (const field of keys) {
      let value = body[field];

      if (typeof value === "string") {
        value = value.trim();
      }

      if (field === "gender" && value !== null) {
        value = value.toLowerCase();
      }

      values.push(value);
      assignments.push(
        `${editableStudentFields[field]} = $${values.length}`
      );
    }

    const result = await pool.query(
      `UPDATE students
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    return res.json({
      success: true,
      message: "Student updated successfully.",
      student: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "That admission number already exists for this school.",
      });
    }

    next(error);
  }
});

router.patch("/:id/status", async (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body || {};

  if (!isValidStudentId(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID.",
    });
  }

  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Status must be active or inactive.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE students
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3
       RETURNING id, admission_number, first_name, last_name, status`,
      [status, id, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    return res.json({
      success: true,
      message: `Student marked ${status}.`,
      student: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});


router.delete("/:id", async (req, res, next) => {
  const { id } = req.params;

  if (!isValidStudentId(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE students
       SET status = 'inactive', updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, admission_number, first_name, last_name, status`,
      [id, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    return res.json({
      success: true,
      message: "Student archived successfully. The record and parent details were preserved.",
      student: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});
// Assign a student to a class and section
router.patch("/:id/class", async (req, res, next) => {
  const studentId = req.params.id;
  const { classId, sectionId = null } = req.body;

  if (!/^[1-9]\d*$/.test(studentId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID",
    });
  }

  if (!Number.isInteger(Number(classId)) || Number(classId) <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid classId is required",
    });
  }

  if (
    sectionId !== null &&
    (!Number.isInteger(Number(sectionId)) || Number(sectionId) <= 0)
  ) {
    return res.status(400).json({
      success: false,
      message: "sectionId must be a positive integer or null",
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
        message: "Student not found",
      });
    }

    const classResult = await pool.query(
      `SELECT id, name
       FROM school_classes
       WHERE id = $1
         AND tenant_id = $2
         AND status = 'active'`,
      [classId, req.user.tenantId]
    );

    if (classResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Active class not found",
      });
    }

    let sectionName = null;

    if (sectionId !== null) {
      const sectionResult = await pool.query(
        `SELECT id, name
         FROM class_sections
         WHERE id = $1
           AND class_id = $2
           AND tenant_id = $3`,
        [sectionId, classId, req.user.tenantId]
      );

      if (sectionResult.rowCount === 0) {
        return res.status(400).json({
          success: false,
          message: "Section does not belong to the selected class",
        });
      }

      sectionName = sectionResult.rows[0].name;
    }

    const result = await pool.query(
      `UPDATE students
       SET class_id = $1,
           section_id = $2,
           class_name = $3,
           section = $4,
           updated_at = NOW()
       WHERE id = $5
         AND tenant_id = $6
       RETURNING id, admission_number, first_name, last_name,
                 class_id, section_id, class_name, section, status`,
      [
        Number(classId),
        sectionId === null ? null : Number(sectionId),
        classResult.rows[0].name,
        sectionName,
        studentId,
        req.user.tenantId,
      ]
    );

    return res.json({
      success: true,
      message: "Student class assignment updated successfully",
      student: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
