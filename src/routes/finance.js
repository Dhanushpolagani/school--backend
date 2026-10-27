
const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

// POST /api/fees/categories
// Create a fee category for the logged-in school.
router.post("/categories", async (req, res, next) => {
  const { name, description = null } = req.body;

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Category name is required",
    });
  }

  if (name.trim().length > 100) {
    return res.status(400).json({
      success: false,
      message: "Category name cannot exceed 100 characters",
    });
  }

  if (
    description !== null &&
    (typeof description !== "string" || description.length > 5000)
  ) {
    return res.status(400).json({
      success: false,
      message: "Description must be text",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO fee_categories (tenant_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, is_active, created_at, updated_at`,
      [req.user.tenantId, name.trim(), description]
    );

    return res.status(201).json({
      success: true,
      message: "Fee category created successfully",
      category: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A fee category with this name already exists",
      });
    }

    next(error);
  }
});

// GET /api/fees/categories
// List fee categories for the logged-in school.
router.get("/categories", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, is_active, created_at, updated_at
       FROM fee_categories
       WHERE tenant_id = $1
       ORDER BY name ASC`,
      [req.user.tenantId]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      categories: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/fees/categories/:id
// Update a category belonging to the logged-in school.
router.patch("/categories/:id", async (req, res, next) => {
  const { id } = req.params;
  const { name, description, is_active } = req.body;

  if (!/^[1-9]\d*$/.test(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid category ID",
    });
  }

  if (
    name === undefined &&
    description === undefined &&
    is_active === undefined
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one field to update",
    });
  }

  if (
    name !== undefined &&
    (typeof name !== "string" || !name.trim() || name.trim().length > 100)
  ) {
    return res.status(400).json({
      success: false,
      message: "Name must contain 1 to 100 characters",
    });
  }

  if (
    description !== undefined &&
    description !== null &&
    typeof description !== "string"
  ) {
    return res.status(400).json({
      success: false,
      message: "Description must be text or null",
    });
  }

  if (
    description !== undefined &&
    typeof description === "string" &&
    description.length > 5000
  ) {
    return res.status(400).json({
      success: false,
      message: "Description cannot exceed 5000 characters",
    });
  }

  if (
    is_active !== undefined &&
    typeof is_active !== "boolean"
  ) {
    return res.status(400).json({
      success: false,
      message: "is_active must be true or false",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE fee_categories
       SET name = COALESCE($1, name),
           description = CASE
             WHEN $2::boolean THEN $3::text
             ELSE description
           END,
           is_active = COALESCE($4, is_active),
           updated_at = NOW()
       WHERE id = $5
         AND tenant_id = $6
       RETURNING id, name, description, is_active, created_at, updated_at`,
      [
        name === undefined ? null : name.trim(),
        description !== undefined,
        description === undefined ? null : description,
        is_active === undefined ? null : is_active,
        id,
        req.user.tenantId,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Fee category not found",
      });
    }

    return res.json({
      success: true,
      message: "Fee category updated successfully",
      category: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A fee category with this name already exists",
      });
    }

    next(error);
  }
});

const VALID_FREQUENCIES = [
  "one_time",
  "monthly",
  "quarterly",
  "annual",
];

// POST /api/fees/structures
router.post("/structures", async (req, res, next) => {
  const {
    classId,
    categoryId,
    academicYear,
    amountPaise,
    frequency = "annual",
    dueDate = null,
  } = req.body;

  if (!/^[1-9]\d*$/.test(String(classId))) {
    return res.status(400).json({
      success: false,
      message: "A valid classId is required",
    });
  }

  if (!/^[1-9]\d*$/.test(String(categoryId))) {
    return res.status(400).json({
      success: false,
      message: "A valid categoryId is required",
    });
  }

  if (
    !Number.isSafeInteger(amountPaise) ||
    amountPaise <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: "amountPaise must be a positive safe integer",
    });
  }

  if (
    typeof academicYear !== "string" ||
    !/^\d{4}-\d{4}$/.test(academicYear) ||
    Number(academicYear.slice(5)) !==
      Number(academicYear.slice(0, 4)) + 1
  ) {
    return res.status(400).json({
      success: false,
      message: "academicYear must be consecutive years, e.g. 2026-2027",
    });
  }

  if (!VALID_FREQUENCIES.includes(frequency)) {
    return res.status(400).json({
      success: false,
      message: "Invalid fee frequency",
    });
  }

  if (
    dueDate !== null &&
    (
      typeof dueDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
      Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)) ||
      new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== dueDate
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "dueDate must be a valid date in YYYY-MM-DD format or null",
    });
  }

  try {
    const tenantId = req.user.tenantId;

    // Verify class belongs to the logged-in school.
    const classResult = await pool.query(
      `SELECT id
       FROM school_classes
       WHERE id = $1
         AND tenant_id = $2
         AND status = 'active'`,
      [Number(classId), tenantId]
    );

    if (classResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Active class not found in your school",
      });
    }

    // Verify category belongs to the logged-in school.
    const categoryResult = await pool.query(
      `SELECT id
       FROM fee_categories
       WHERE id = $1
         AND tenant_id = $2
         AND is_active = TRUE`,
      [Number(categoryId), tenantId]
    );

    if (categoryResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Active fee category not found in your school",
      });
    }

    const result = await pool.query(
      `INSERT INTO fee_structures (
         tenant_id,
         class_id,
         category_id,
         academic_year,
         amount_paise,
         frequency,
         due_date
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, class_id, category_id, academic_year,
                 amount_paise, frequency, due_date,
                 status, created_at`,
      [
        tenantId,
        Number(classId),
        Number(categoryId),
        academicYear,
        amountPaise,
        frequency,
        dueDate,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Fee structure created successfully",
      feeStructure: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A fee structure already exists for this class, category, and academic year",
      });
    }

    next(error);
  }
});

// GET /api/fees/structures
router.get("/structures", async (req, res, next) => {
  const { classId, academicYear } = req.query;

  if (
    classId !== undefined &&
    !/^[1-9]\d*$/.test(classId)
  ) {
    return res.status(400).json({
      success: false,
      message: "classId must be a positive integer",
    });
  }

  if (
    academicYear !== undefined &&
    (
      !/^\d{4}-\d{4}$/.test(academicYear) ||
      Number(academicYear.slice(5)) !==
        Number(academicYear.slice(0, 4)) + 1
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "academicYear must be consecutive years, e.g. 2026-2027",
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         fs.id,
         fs.class_id,
         sc.name AS class_name,
         fs.category_id,
         fc.name AS category_name,
         fs.academic_year,
         fs.amount_paise,
         fs.frequency,
         fs.due_date,
         fs.status
       FROM fee_structures fs
       JOIN school_classes sc
         ON sc.id = fs.class_id
        AND sc.tenant_id = fs.tenant_id
       JOIN fee_categories fc
         ON fc.id = fs.category_id
        AND fc.tenant_id = fs.tenant_id
       WHERE fs.tenant_id = $1
         AND ($2::bigint IS NULL OR fs.class_id = $2)
         AND ($3::text IS NULL OR fs.academic_year = $3)
       ORDER BY fs.academic_year DESC, sc.name, fc.name`,
      [
        req.user.tenantId,
        classId === undefined ? null : Number(classId),
        academicYear === undefined ? null : academicYear,
      ]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      feeStructures: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

/* =========================================
   STUDENT FEE ASSIGNMENTS
========================================= */

// POST /api/fees/assignments
// Assign a fee structure to a student
router.post("/assignments", async (req, res) => {
  try {
    const {
      studentId,
      feeStructureId,
      amountPaise,
      discountPaise = 0,
      dueDate,
      notes
    } = req.body;

    const studentIdNum = Number(studentId);
    const structureIdNum = Number(feeStructureId);
    const discountNum = Number(discountPaise);

    if (
      !Number.isSafeInteger(studentIdNum) ||
      studentIdNum <= 0 ||
      !Number.isSafeInteger(structureIdNum) ||
      structureIdNum <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid studentId and feeStructureId are required"
      });
    }

    if (
      !Number.isSafeInteger(discountNum) ||
      discountNum < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "discountPaise must be a non-negative integer"
      });
    }

    // Verify the student belongs to this school.
    const studentResult = await pool.query(
      `SELECT id
       FROM students
       WHERE id = $1 AND tenant_id = $2`,
      [studentIdNum, req.user.tenantId]
    );

    if (studentResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found in this school"
      });
    }

    // Get the active fee structure for this school.
    const structureResult = await pool.query(
      `SELECT id, amount_paise, due_date
       FROM fee_structures
       WHERE id = $1
         AND tenant_id = $2
         AND status = 'active'`,
      [structureIdNum, req.user.tenantId]
    );

    if (structureResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Active fee structure not found"
      });
    }

    const structure = structureResult.rows[0];

    const finalAmount =
      amountPaise === undefined
        ? Number(structure.amount_paise)
        : Number(amountPaise);

    if (
      !Number.isSafeInteger(finalAmount) ||
      finalAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "amountPaise must be a positive integer"
      });
    }

    if (discountNum > finalAmount) {
      return res.status(400).json({
        success: false,
        message: "Discount cannot exceed the assigned fee"
      });
    }

    const finalDueDate = dueDate || structure.due_date;

    const result = await pool.query(
      `INSERT INTO student_fee_assignments
        (
          tenant_id,
          student_id,
          fee_structure_id,
          amount_paise,
          discount_paise,
          due_date,
          status,
          notes
        )
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
       RETURNING *`,
      [
        req.user.tenantId,
        studentIdNum,
        structureIdNum,
        finalAmount,
        discountNum,
        finalDueDate,
        notes || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Fee assigned to student successfully",
      assignment: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message:
          "This fee structure is already assigned to this student"
      });
    }

    if (error.code === "23503") {
      return res.status(400).json({
        success: false,
        message: "Invalid student or fee structure reference"
      });
    }

    console.error("Create fee assignment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to assign fee"
    });
  }
});


// GET /api/fees/assignments
// List assignments for the authenticated school
// Optional filter: ?studentId=1
router.get("/assignments", async (req, res) => {
  try {
    const { studentId } = req.query;

    const params = [req.user.tenantId];

    let studentFilter = "";

    if (studentId !== undefined) {
      const id = Number(studentId);

      if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({
          success: false,
          message: "studentId must be a positive integer"
        });
      }

      params.push(id);
      studentFilter = " AND a.student_id = $2";
    }

    const result = await pool.query(
      `SELECT
         a.id,
         a.student_id,
         a.fee_structure_id,
         a.amount_paise,
         a.discount_paise,
         a.due_date,
         a.status,
         a.notes,
         a.created_at,
         fs.academic_year,
         fs.frequency,
         fc.name AS category_name,
         sc.name AS class_name
       FROM student_fee_assignments a
       JOIN fee_structures fs
         ON fs.id = a.fee_structure_id
        AND fs.tenant_id = a.tenant_id
       JOIN fee_categories fc
         ON fc.id = fs.category_id
        AND fc.tenant_id = a.tenant_id
       JOIN school_classes sc
         ON sc.id = fs.class_id
        AND sc.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1${studentFilter}
       ORDER BY a.created_at DESC`,
      params
    );

    return res.json({
      success: true,
      count: result.rowCount,
      assignments: result.rows
    });
  } catch (error) {
    console.error("Get fee assignments error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch fee assignments"
    });
  }
});
// GET /api/fees/payments/:id
router.get("/payments/:id", async (req, res) => {
  try {
    const paymentId = Number(req.params.id);

    if (!Number.isSafeInteger(paymentId) || paymentId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment ID"
      });
    }

   const result = await pool.query(
  `SELECT
      p.*,
      a.student_id,
      s.first_name,
      s.last_name,
      s.admission_number,
      s.class_name,
      s.section,
      s.roll_number,
      fs.academic_year,
      fc.name AS category_name
   FROM fee_payments p
   JOIN student_fee_assignments a
     ON a.id = p.assignment_id
    AND a.tenant_id = p.tenant_id
   JOIN students s
     ON s.id = a.student_id
    AND s.tenant_id = a.tenant_id
   JOIN fee_structures fs
     ON fs.id = a.fee_structure_id
    AND fs.tenant_id = a.tenant_id
   JOIN fee_categories fc
     ON fc.id = fs.category_id
    AND fc.tenant_id = a.tenant_id
   WHERE p.id = $1
     AND p.tenant_id = $2`,
  [paymentId, req.user.tenantId]
);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment receipt not found"
      });
    }

    return res.json({
      success: true,
      receipt: result.rows[0]
    });
  } catch (error) {
    console.error("Get payment receipt error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch payment receipt"
    });
  }
});

/* POST /api/fees/payments */
router.post("/payments", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      assignmentId,
      amountPaise,
      paymentMethod,
      transactionReference,
      paymentDate,
      notes
    } = req.body;

    const assignmentIdNum = Number(assignmentId);
    const amountNum = Number(amountPaise);

    const validMethods = [
      "cash", "upi", "bank_transfer",
      "card", "cheque", "online", "other"
    ];

    if (
      !Number.isSafeInteger(assignmentIdNum) ||
      assignmentIdNum <= 0 ||
      !Number.isSafeInteger(amountNum) ||
      amountNum <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid assignmentId and positive amountPaise are required"
      });
    }

    if (!validMethods.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Invalid paymentMethod",
        allowedMethods: validMethods
      });
    }

    await client.query("BEGIN");

    const assignmentResult = await client.query(
      `SELECT id, amount_paise, discount_paise, status
       FROM student_fee_assignments
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [assignmentIdNum, req.user.tenantId]
    );

    if (assignmentResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Fee assignment not found"
      });
    }

    const assignment = assignmentResult.rows[0];

    if (assignment.status !== "active") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Fee assignment is not active"
      });
    }

    const paidResult = await client.query(
      `SELECT COALESCE(SUM(amount_paise), 0) AS total_paid
       FROM fee_payments
       WHERE tenant_id = $1 AND assignment_id = $2`,
      [req.user.tenantId, assignmentIdNum]
    );

    const outstanding =
      Number(assignment.amount_paise) -
      Number(assignment.discount_paise) -
      Number(paidResult.rows[0].total_paid);

    if (amountNum > outstanding) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Payment exceeds outstanding balance",
        outstandingPaise: outstanding
      });
    }

    const { randomUUID } = require("crypto");
    const receiptNumber = `RCP-${randomUUID()}`;

    const result = await client.query(
      `INSERT INTO fee_payments (
         tenant_id, assignment_id, receipt_number,
         amount_paise, payment_method, transaction_reference,
         payment_date, received_by, notes
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        req.user.tenantId,
        assignmentIdNum,
        receiptNumber,
        amountNum,
        paymentMethod,
        transactionReference || null,
        paymentDate || new Date().toISOString().slice(0, 10),
        req.user.id,
        notes || null
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Fee payment recorded successfully",
      payment: result.rows[0],
      balancePaise: outstanding - amountNum
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Create fee payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to record fee payment"
    });
  } finally {
    client.release();
  }
});


/* GET /api/fees/payments */
router.get("/payments", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM fee_payments
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [req.user.tenantId]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      payments: result.rows
    });
  } catch (error) {
    console.error("Get fee payments error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch fee payments"
    });
  }
});

/* GET /api/fees/outstanding */
router.get("/outstanding", async (req, res, next) => {
  try {
    const { studentId } = req.query;

    if (
      studentId !== undefined &&
      !/^[1-9]\d*$/.test(String(studentId))
    ) {
      return res.status(400).json({
        success: false,
        message: "studentId must be a positive integer",
      });
    }

    const result = await pool.query(
      `SELECT
          a.student_id,
          s.first_name,
          s.last_name,
          COUNT(a.id)::int AS fee_assignments,
          SUM(a.amount_paise)::bigint AS total_fee_paise,
          SUM(a.discount_paise)::bigint AS total_discount_paise,
          COALESCE(SUM(p.paid_paise), 0)::bigint AS total_paid_paise,
          (
            SUM(a.amount_paise)
            - SUM(a.discount_paise)
            - COALESCE(SUM(p.paid_paise), 0)
          )::bigint AS outstanding_paise
       FROM student_fee_assignments a
       JOIN students s
         ON s.id = a.student_id
        AND s.tenant_id = a.tenant_id
       LEFT JOIN (
          SELECT
            assignment_id,
            tenant_id,
            SUM(amount_paise) AS paid_paise
          FROM fee_payments
          GROUP BY assignment_id, tenant_id
       ) p
         ON p.assignment_id = a.id
        AND p.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1
         AND a.status = 'active'
         AND ($2::bigint IS NULL OR a.student_id = $2)
       GROUP BY a.student_id, s.first_name, s.last_name
       ORDER BY s.first_name, s.last_name`,
      [
        req.user.tenantId,
        studentId === undefined ? null : Number(studentId),
      ]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      balances: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

/* GET /api/fees/students/:studentId/payments */
router.get("/students/:studentId/payments", async (req, res, next) => {
  try {
    const { studentId } = req.params;

    if (!/^[1-9]\d*$/.test(studentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student ID",
      });
    }

    const result = await pool.query(
      `SELECT
          p.id AS payment_id,
          p.receipt_number,
          p.amount_paise,
          p.payment_method,
          p.transaction_reference,
          p.payment_date,
          p.notes,
          a.id AS assignment_id,
          a.amount_paise AS assigned_fee_paise,
          a.discount_paise,
          fs.academic_year,
          fc.name AS category_name
       FROM fee_payments p
       JOIN student_fee_assignments a
         ON a.id = p.assignment_id
        AND a.tenant_id = p.tenant_id
       JOIN fee_structures fs
         ON fs.id = a.fee_structure_id
        AND fs.tenant_id = a.tenant_id
       JOIN fee_categories fc
         ON fc.id = fs.category_id
        AND fc.tenant_id = a.tenant_id
       WHERE p.tenant_id = $1
         AND a.student_id = $2
       ORDER BY p.payment_date DESC, p.id DESC`,
      [req.user.tenantId, Number(studentId)]
    );

    return res.json({
      success: true,
      studentId,
      count: result.rowCount,
      payments: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

/* GET /api/fees/payments/:id/print
   Display a printable fee receipt.
*/
router.get("/payments/:id/print", async (req, res) => {
  try {
    const paymentId = Number(req.params.id);

    if (!Number.isSafeInteger(paymentId) || paymentId <= 0) {
      return res.status(400).send("Invalid payment ID");
    }

    const result = await pool.query(
      `SELECT
          p.*,
          a.student_id,
          s.first_name,
          s.last_name,
          s.admission_number,
          s.class_name,
          s.section,
          s.roll_number,
          fs.academic_year,
          fc.name AS category_name
       FROM fee_payments p
       JOIN student_fee_assignments a
         ON a.id = p.assignment_id
        AND a.tenant_id = p.tenant_id
       JOIN students s
         ON s.id = a.student_id
        AND s.tenant_id = a.tenant_id
       JOIN fee_structures fs
         ON fs.id = a.fee_structure_id
        AND fs.tenant_id = a.tenant_id
       JOIN fee_categories fc
         ON fc.id = fs.category_id
        AND fc.tenant_id = a.tenant_id
       WHERE p.id = $1
         AND p.tenant_id = $2`,
         
      [paymentId, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Payment receipt not found");
    }

    const payment = result.rows[0];

    // Escape database values before inserting them into HTML.
    const escapeHtml = (value) =>
      String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);

    const money = (paise) =>
      new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR"
      }).format(Number(paise || 0) / 100);

    const paymentDate = new Date(payment.payment_date);
    const formattedDate = Number.isNaN(paymentDate.getTime())
      ? "Not available"
      : paymentDate.toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Kolkata"
        });

    const studentName =
      `${payment.first_name} ${payment.last_name || ""}`.trim();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fee Receipt - ${escapeHtml(payment.receipt_number)}</title>
  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 30px;
      background: #f3f4f6;
      color: #1f2937;
      font-family: Arial, Helvetica, sans-serif;
    }

    .receipt {
      max-width: 760px;
      margin: 20px auto;
      padding: 36px;
      background: white;
      border: 1px solid #d1d5db;
      border-radius: 10px;
    }

    .header {
      text-align: center;
      padding-bottom: 22px;
      border-bottom: 2px solid #1d4ed8;
    }

    .header h1 {
      margin: 0 0 8px;
      color: #1d4ed8;
      font-size: 28px;
    }

    .header p { margin: 5px 0; color: #6b7280; }

    .receipt-title {
      margin: 24px 0;
      text-align: center;
      font-size: 20px;
      letter-spacing: 2px;
    }

    .details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 26px;
    }

    .item {
      padding: 12px;
      background: #f9fafb;
      border-radius: 6px;
      overflow-wrap: anywhere;
    }

    .label {
      display: block;
      margin-bottom: 6px;
      color: #6b7280;
      font-size: 12px;
      text-transform: uppercase;
    }

    .value { font-weight: 600; }

    table {
      width: 100%;
      margin-top: 12px;
      border-collapse: collapse;
    }

    th, td {
      padding: 14px 10px;
      border-bottom: 1px solid #e5e7eb;
      text-align: left;
    }

    th { background: #f9fafb; }

    .total {
      margin-top: 22px;
      padding: 20px;
      background: #eff6ff;
      border-radius: 8px;
      text-align: right;
    }

    .total span {
      display: block;
      color: #1d4ed8;
      font-size: 13px;
    }

    .total strong {
      display: block;
      margin-top: 6px;
      color: #1d4ed8;
      font-size: 28px;
    }

    .footer {
      margin-top: 32px;
      padding-top: 18px;
      border-top: 1px dashed #9ca3af;
      text-align: center;
      color: #6b7280;
      font-size: 13px;
    }

    .actions {
      margin: 20px auto;
      text-align: center;
    }

    .actions button {
      padding: 12px 24px;
      border: 0;
      border-radius: 6px;
      background: #1d4ed8;
      color: white;
      font-size: 15px;
      cursor: pointer;
    }

    @media (max-width: 600px) {
      body { padding: 10px; }
      .receipt { padding: 20px; }
      .details { grid-template-columns: 1fr; }
    }

    @media print {
      body { padding: 0; background: white; }
      .receipt {
        max-width: none;
        margin: 0;
        padding: 15px;
        border: 0;
        border-radius: 0;
      }
      .actions { display: none; }
    }
  </style>
</head>
<body>
  <main class="receipt">
    <header class="header">
      <h1>School ERP</h1>
      <p>Official Fee Payment Receipt</p>
    </header>

    <h2 class="receipt-title">PAYMENT RECEIPT</h2>

    <section class="details">
      <div class="item">
        <span class="label">Receipt Number</span>
        <span class="value">${escapeHtml(payment.receipt_number)}</span>
      </div>
      <div class="item">
        <span class="label">Payment Date</span>
        <span class="value">${escapeHtml(formattedDate)}</span>
      </div>
      <div class="item">
        <span class="label">Student Name</span>
        <span class="value">${escapeHtml(studentName)}</span>
      </div>
      <div class="item">
        <span class="label">Admission Number</span>
        <span class="value">${escapeHtml(payment.admission_number)}</span>
      </div>
      <div class="item">
        <span class="label">Class / Section</span>
        <span class="value">${escapeHtml(payment.class_name)} / ${escapeHtml(payment.section)}</span>
      </div>
      <div class="item">
        <span class="label">Academic Year</span>
        <span class="value">${escapeHtml(payment.academic_year)}</span>
      </div>
    </section>

    <table>
      <thead>
        <tr>
          <th>Fee Description</th>
          <th>Payment Method</th>
          <th>Transaction Reference</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${escapeHtml(payment.category_name)}</td>
          <td>${escapeHtml(payment.payment_method)}</td>
          <td>${escapeHtml(payment.transaction_reference || "—")}</td>
        </tr>
      </tbody>
    </table>

    <section class="total">
      <span>AMOUNT PAID</span>
      <strong>${escapeHtml(money(payment.amount_paise))}</strong>
    </section>

    <footer class="footer">
      <p>This receipt confirms the payment recorded by the school.</p>
      <p>Please retain this receipt for your records.</p>
    </footer>
  </main>

  <div class="actions">
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
</body>
</html>`;

    res.type("html").send(html);
  } catch (error) {
    console.error("Print payment receipt error:", error);
    res.status(500).send("Failed to generate payment receipt");
  }
});


// GET /api/finance/summary
// High-level financial summary
router.get("/summary", async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId;
    const result = await pool.query(
      `SELECT
         COALESCE(SUM(amount_paise), 0) AS total_collected_paise,
         COUNT(*) AS total_transactions
       FROM fee_payments
       WHERE tenant_id = $1`,
      [tenantId]
    );

    const assignments = await pool.query(
      `SELECT
         COALESCE(SUM(net_amount_paise), 0) AS total_assigned_paise,
         COALESCE(SUM(paid_amount_paise), 0) AS total_paid_paise,
         COALESCE(SUM(net_amount_paise - paid_amount_paise), 0) AS total_due_paise
       FROM student_fee_assignments
       WHERE tenant_id = $1`,
      [tenantId]
    );

    return res.json({
      success: true,
      data: {
        totalCollectedPaise: Number(result.rows[0].total_collected_paise),
        totalAssignedPaise: Number(assignments.rows[0].total_assigned_paise),
        totalDuePaise: Number(assignments.rows[0].total_due_paise),
        totalTransactions: Number(result.rows[0].total_transactions),
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
