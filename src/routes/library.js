
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

router.use(authenticateToken);

function tenantIdOf(req) {
  return req.user?.tenantId;
}

function isPositiveId(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0;
}

function isAdmin(req) {
  const roles = req.user?.roles || [];
  return roles.includes("school_admin") || roles.includes("admin");
}

// GET /api/library/summary
router.get("/summary", async (req, res) => {
  try {
    const tenantId = tenantIdOf(req);
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: "Tenant authentication required."
      });
    }

    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)
          FROM library_books
          WHERE tenant_id = $1 AND status = 'active') AS total_titles,

         (SELECT COUNT(*)
          FROM library_book_copies
          WHERE tenant_id = $1) AS total_copies,

         (SELECT COUNT(*)
          FROM library_book_copies
          WHERE tenant_id = $1 AND status = 'available') AS available_copies,

         (SELECT COUNT(*)
          FROM library_loans
          WHERE tenant_id = $1 AND status = 'issued') AS active_loans,

         (SELECT COUNT(*)
          FROM library_loans
          WHERE tenant_id = $1
            AND status = 'issued'
            AND due_date < CURRENT_DATE) AS overdue_loans`,
      [tenantId]
    );

    return res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error("Library summary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch library summary."
    });
  }
});

// POST /api/library/books
router.post("/books", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can add books."
    });
  }

  const tenantId = tenantIdOf(req);
  if (!tenantId) {
    return res.status(401).json({
      success: false,
      message: "Tenant authentication required."
    });
  }

  const {
    title,
    author,
    isbn,
    category,
    publisher,
    publicationYear,
    edition,
    language,
    description
  } = req.body;

  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({
      success: false,
      message: "Book title is required."
    });
  }

  if (
    publicationYear !== undefined &&
    publicationYear !== null &&
    (!Number.isInteger(Number(publicationYear)) ||
      Number(publicationYear) < 1000 ||
      Number(publicationYear) > 2200)
  ) {
    return res.status(400).json({
      success: false,
      message: "Publication year is invalid."
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO library_books
       (tenant_id, title, author, isbn, category, publisher,
        publication_year, edition, language, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        tenantId,
        title.trim(),
        author?.trim() || null,
        isbn?.trim() || null,
        category?.trim() || null,
        publisher?.trim() || null,
        publicationYear ?? null,
        edition?.trim() || null,
        language?.trim() || "English",
        description?.trim() || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Book added successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A book with this ISBN already exists in your school."
      });
    }

    console.error("Add book error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to add book."
    });
  }
});

// GET /api/library/books
router.get("/books", async (req, res) => {
  const tenantId = tenantIdOf(req);
  if (!tenantId) {
    return res.status(401).json({
      success: false,
      message: "Tenant authentication required."
    });
  }

  const search = String(req.query.search || "").trim();
  const category = String(req.query.category || "").trim();
  const status = String(req.query.status || "active").trim();

  if (!["active", "inactive", "all"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Status must be active, inactive, or all."
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         b.*,
         COUNT(c.id)::int AS total_copies,
         COUNT(c.id) FILTER (WHERE c.status = 'available')::int
           AS available_copies,
         COUNT(c.id) FILTER (WHERE c.status = 'issued')::int
           AS issued_copies
       FROM library_books b
       LEFT JOIN library_book_copies c
         ON c.book_id = b.id AND c.tenant_id = b.tenant_id
       WHERE b.tenant_id = $1
         AND ($2 = '' OR
              b.title ILIKE '%' || $2 || '%' OR
              COALESCE(b.author, '') ILIKE '%' || $2 || '%' OR
              COALESCE(b.isbn, '') ILIKE '%' || $2 || '%')
         AND ($3 = '' OR b.category ILIKE $3)
         AND ($4 = 'all' OR b.status = $4)
       GROUP BY b.id
       ORDER BY b.title ASC`,
      [tenantId, search, category, status]
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    console.error("List books error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch books."
    });
  }
});

// GET /api/library/books/:bookId
router.get("/books/:bookId", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { bookId } = req.params;

  if (!isPositiveId(bookId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid book ID."
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         b.*,
         COUNT(c.id)::int AS total_copies,
         COUNT(c.id) FILTER (WHERE c.status = 'available')::int
           AS available_copies,
         COUNT(c.id) FILTER (WHERE c.status = 'issued')::int
           AS issued_copies
       FROM library_books b
       LEFT JOIN library_book_copies c
         ON c.book_id = b.id AND c.tenant_id = b.tenant_id
       WHERE b.tenant_id = $1 AND b.id = $2
       GROUP BY b.id`,
      [tenantId, bookId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Book not found."
      });
    }

    return res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error("Get book error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch book."
    });
  }
});

// PATCH /api/library/books/:bookId
router.patch("/books/:bookId", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can update books."
    });
  }

  const tenantId = tenantIdOf(req);
  const { bookId } = req.params;

  if (!isPositiveId(bookId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid book ID."
    });
  }

  const fields = {
    title: "title",
    author: "author",
    isbn: "isbn",
    category: "category",
    publisher: "publisher",
    publicationYear: "publication_year",
    edition: "edition",
    language: "language",
    description: "description",
    status: "status"
  };

  const updates = [];
  const values = [tenantId, bookId];

  for (const [key, column] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(req.body, key)) continue;

    let value = req.body[key];

    if (["title", "status"].includes(key) &&
        (typeof value !== "string" || !value.trim())) {
      return res.status(400).json({
        success: false,
        message: `${key} cannot be empty.`
      });
    }

    if (typeof value === "string") value = value.trim();

    if (key === "status" && !["active", "inactive"].includes(value)) {
      return res.status(400).json({
        success: false,
        message: "Status must be active or inactive."
      });
    }

    if (key === "publicationYear" && value !== null &&
        (!Number.isInteger(Number(value)) ||
          Number(value) < 1000 || Number(value) > 2200)) {
      return res.status(400).json({
        success: false,
        message: "Publication year is invalid."
      });
    }

    if (key === "publicationYear" && value !== null) {
      value = Number(value);
    }

    updates.push(`${column} = $${values.length + 1}`);
    values.push(value === "" ? null : value);
  }

  if (!updates.length) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one field to update."
    });
  }

  updates.push("updated_at = NOW()");

  try {
    const result = await pool.query(
      `UPDATE library_books
       SET ${updates.join(", ")}
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      values
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Book not found."
      });
    }

    return res.json({
      success: true,
      message: "Book updated successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A book with this ISBN already exists in your school."
      });
    }

    console.error("Update book error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update book."
    });
  }
});

/* ==========================================
   PHYSICAL BOOK COPY MANAGEMENT
   ========================================== */

// POST /api/library/books/:bookId/copies
router.post("/books/:bookId/copies", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can add book copies."
    });
  }

  const tenantId = tenantIdOf(req);
  const { bookId } = req.params;
  const { barcode, acquisitionDate, purchasePrice, conditionNotes } = req.body;

  if (!isPositiveId(bookId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid book ID."
    });
  }

  if (typeof barcode !== "string" || !barcode.trim()) {
    return res.status(400).json({
      success: false,
      message: "Barcode is required."
    });
  }

  if (
    purchasePrice !== undefined &&
    purchasePrice !== null &&
    (!Number.isFinite(Number(purchasePrice)) || Number(purchasePrice) < 0)
  ) {
    return res.status(400).json({
      success: false,
      message: "Purchase price must be a non-negative number."
    });
  }

  if (
    acquisitionDate !== undefined &&
    acquisitionDate !== null &&
    !/^\d{4}-\d{2}-\d{2}$/.test(acquisitionDate)
  ) {
    return res.status(400).json({
      success: false,
      message: "Acquisition date must use YYYY-MM-DD."
    });
  }

  try {
    const book = await pool.query(
      `SELECT id
       FROM library_books
       WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [bookId, tenantId]
    );

    if (!book.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Active book not found in your school."
      });
    }

    const result = await pool.query(
      `INSERT INTO library_book_copies
       (tenant_id, book_id, barcode, acquisition_date,
        purchase_price, condition_notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        tenantId,
        bookId,
        barcode.trim(),
        acquisitionDate || null,
        purchasePrice ?? null,
        conditionNotes?.trim() || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Book copy added successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This barcode already exists in your school."
      });
    }

    if (error.code === "23503") {
      return res.status(400).json({
        success: false,
        message: "Invalid book reference."
      });
    }

    console.error("Add book copy error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to add book copy."
    });
  }
});

// GET /api/library/books/:bookId/copies
router.get("/books/:bookId/copies", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { bookId } = req.params;
  const status = String(req.query.status || "all");

  if (!isPositiveId(bookId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid book ID."
    });
  }

  if (
    !["all", "available", "issued", "lost", "damaged", "withdrawn"]
      .includes(status)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid copy status."
    });
  }

  try {
    const book = await pool.query(
      `SELECT id
       FROM library_books
       WHERE id = $1 AND tenant_id = $2`,
      [bookId, tenantId]
    );

    if (!book.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Book not found."
      });
    }

    const result = await pool.query(
      `SELECT c.*,
              b.title AS book_title,
              b.author AS book_author
       FROM library_book_copies c
       JOIN library_books b
         ON b.id = c.book_id AND b.tenant_id = c.tenant_id
       WHERE c.tenant_id = $1
         AND c.book_id = $2
         AND ($3 = 'all' OR c.status = $3)
       ORDER BY c.id`,
      [tenantId, bookId, status]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows
    });
  } catch (error) {
    console.error("List book copies error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch book copies."
    });
  }
});

// PATCH /api/library/copies/:copyId
router.patch("/copies/:copyId", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can update book copies."
    });
  }

  const tenantId = tenantIdOf(req);
  const { copyId } = req.params;

  if (!isPositiveId(copyId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid copy ID."
    });
  }

  const allowed = {
    barcode: "barcode",
    acquisitionDate: "acquisition_date",
    purchasePrice: "purchase_price",
    conditionNotes: "condition_notes",
    status: "status"
  };

  const values = [tenantId, copyId];
  const updates = [];

  for (const [key, column] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(req.body, key)) continue;

    let value = req.body[key];

    if (key === "barcode") {
      if (typeof value !== "string" || !value.trim()) {
        return res.status(400).json({
          success: false,
          message: "Barcode cannot be empty."
        });
      }
      value = value.trim();
    }

    if (key === "status") {
      if (!["available", "lost", "damaged", "withdrawn"].includes(value)) {
        return res.status(400).json({
          success: false,
          message:
            "Status must be available, lost, damaged, or withdrawn."
        });
      }
    }

    if (key === "purchasePrice" && value !== null &&
        (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      return res.status(400).json({
        success: false,
        message: "Purchase price must be non-negative."
      });
    }

    if (key === "acquisitionDate" && value !== null &&
        (typeof value !== "string" ||
         !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
      return res.status(400).json({
        success: false,
        message: "Acquisition date must use YYYY-MM-DD or null."
      });
    }

    updates.push(`${column} = $${values.length + 1}`);
    values.push(value === "" ? null : value);
  }

  if (!updates.length) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one field to update."
    });
  }

  updates.push("updated_at = NOW()");

  try {
    const result = await pool.query(
      `UPDATE library_book_copies c
       SET ${updates.join(", ")}
       WHERE c.tenant_id = $1
         AND c.id = $2
         AND NOT EXISTS (
           SELECT 1
           FROM library_loans l
           WHERE l.tenant_id = c.tenant_id
             AND l.copy_id = c.id
             AND l.status = 'issued'
         )
       RETURNING c.*`,
      values
    );

    if (!result.rowCount) {
      const existing = await pool.query(
        `SELECT id
         FROM library_book_copies
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, copyId]
      );

      return res.status(existing.rowCount ? 409 : 404).json({
        success: false,
        message: existing.rowCount
          ? "This copy has an active loan and cannot be updated."
          : "Book copy not found."
      });
    }

    return res.json({
      success: true,
      message: "Book copy updated successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This barcode already exists in your school."
      });
    }

    console.error("Update book copy error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update book copy."
    });
  }
});

/* ==========================================
   LIBRARY ISSUE, RETURN AND LOAN REPORTS
   ========================================== */

const LIBRARY_FINE_PER_DAY = 5;

// POST /api/library/loans/issue
router.post("/loans/issue", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { copyId, studentId, dueDate, remarks } = req.body;

  if (!tenantId) {
    return res.status(401).json({
      success: false,
      message: "Tenant authentication required."
    });
  }

  // Permit school administrators and teachers to issue books.
  const roles = req.user?.roles || [];
  if (
    !roles.includes("school_admin") &&
    !roles.includes("admin") &&
    !roles.includes("teacher")
  ) {
    return res.status(403).json({
      success: false,
      message: "You are not authorized to issue books."
    });
  }

  if (!isPositiveId(copyId) || !isPositiveId(studentId)) {
    return res.status(400).json({
      success: false,
      message: "Valid copyId and studentId are required."
    });
  }

  if (
    typeof dueDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
    !Number.isFinite(Date.parse(`${dueDate}T00:00:00Z`)) ||
    new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== dueDate
  ) {
    return res.status(400).json({
      success: false,
      message: "dueDate must be a valid date in YYYY-MM-DD format."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Validate the student belongs to the authenticated tenant.
    const studentResult = await client.query(
      `SELECT id
       FROM students
       WHERE id = $1 AND tenant_id = $2
       FOR SHARE`,
      [studentId, tenantId]
    );

    if (!studentResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Student not found in your school."
      });
    }

    // Lock the copy to prevent concurrent duplicate issues.
    const copyResult = await client.query(
      `SELECT c.id, c.status, b.status AS book_status, b.title
       FROM library_book_copies c
       JOIN library_books b
         ON b.id = c.book_id AND b.tenant_id = c.tenant_id
       WHERE c.id = $1 AND c.tenant_id = $2
       FOR UPDATE OF c`,
      [copyId, tenantId]
    );

    if (!copyResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Book copy not found in your school."
      });
    }

    const copy = copyResult.rows[0];

    if (copy.book_status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This book is inactive and cannot be issued."
      });
    }

    if (copy.status !== "available") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: `This copy is not available. Current status: ${copy.status}.`
      });
    }

    const dateCheck = await client.query(
      `SELECT $1::date >= CURRENT_DATE AS valid_due_date`,
      [dueDate]
    );

    if (!dateCheck.rows[0].valid_due_date) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Due date cannot be in the past."
      });
    }

    const issuedBy = isPositiveId(req.user?.sub)
      ? Number(req.user.sub)
      : null;

    const loanResult = await client.query(
      `INSERT INTO library_loans
       (tenant_id, copy_id, student_id, issue_date, due_date,
        status, remarks, issued_by)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, 'issued', $5, $6)
       RETURNING *`,
      [
        tenantId,
        copyId,
        studentId,
        dueDate,
        typeof remarks === "string" ? remarks.trim() || null : null,
        issuedBy
      ]
    );

    await client.query(
      `UPDATE library_book_copies
       SET status = 'issued', updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [copyId, tenantId]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Book issued successfully.",
      data: {
        ...loanResult.rows[0],
        bookTitle: copy.title
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This copy already has an active loan."
      });
    }

    console.error("Issue book error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to issue book."
    });
  } finally {
    client.release();
  }
});


// POST /api/library/loans/:loanId/return
router.post("/loans/:loanId/return", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { loanId } = req.params;

  if (!tenantId) {
    return res.status(401).json({
      success: false,
      message: "Tenant authentication required."
    });
  }

  const roles = req.user?.roles || [];
  if (
    !roles.includes("school_admin") &&
    !roles.includes("admin") &&
    !roles.includes("teacher")
  ) {
    return res.status(403).json({
      success: false,
      message: "You are not authorized to process book returns."
    });
  }

  if (!isPositiveId(loanId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid loan ID."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const loanResult = await client.query(
      `SELECT l.*, c.id AS physical_copy_id
       FROM library_loans l
       JOIN library_book_copies c
         ON c.id = l.copy_id AND c.tenant_id = l.tenant_id
       WHERE l.id = $1 AND l.tenant_id = $2
       FOR UPDATE OF l, c`,
      [loanId, tenantId]
    );

    if (!loanResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Loan not found in your school."
      });
    }

    const loan = loanResult.rows[0];

    if (loan.status !== "issued") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This loan has already been returned or marked lost."
      });
    }

    const overdueResult = await client.query(
      `SELECT GREATEST(CURRENT_DATE - $1::date, 0)::int AS overdue_days`,
      [loan.due_date]
    );

    const overdueDays = overdueResult.rows[0].overdue_days;
    const fine = overdueDays * LIBRARY_FINE_PER_DAY;

    const receivedBy = isPositiveId(req.user?.sub)
      ? Number(req.user.sub)
      : null;

    const returnedResult = await client.query(
      `UPDATE library_loans
       SET status = 'returned',
           returned_at = NOW(),
           fine_amount = fine_amount + $3,
           received_by = $4,
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [loanId, tenantId, fine, receivedBy]
    );

 
    // Check whether a queued reservation exists for this book.
    const reservationResult = await client.query(
      `SELECT r.id, r.student_id
       FROM library_reservations r
       WHERE r.tenant_id = $1
         AND r.book_id = (
           SELECT book_id
           FROM library_book_copies
           WHERE id = $2 AND tenant_id = $1
         )
         AND r.status = 'queued'
       ORDER BY r.reserved_at ASC, r.id ASC
       LIMIT 1
       FOR UPDATE`,
      [tenantId, loan.physical_copy_id]
    );

    let fulfilledReservation = null;

    if (reservationResult.rowCount > 0) {
      // Reserve this copy for the earliest waiting student.
      const settingsResult = await client.query(
        `SELECT reservation_hold_days
         FROM library_settings
         WHERE tenant_id = $1`,
        [tenantId]
      );

      if (settingsResult.rowCount === 0) {
        throw new Error(
          "Library settings not configured for this school."
        );
      }

      const holdDays =
        settingsResult.rows[0].reservation_hold_days;

      const reservation = reservationResult.rows[0];

      const readyResult = await client.query(
        `UPDATE library_reservations
         SET status = 'ready',
             ready_at = NOW(),
             expires_at = NOW() + ($3 * INTERVAL '1 day'),
             updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND status = 'queued'
         RETURNING id, book_id, student_id, status,
                   ready_at, expires_at`,
        [reservation.id, tenantId, holdDays]
      );

      if (readyResult.rowCount > 0) {
        fulfilledReservation = readyResult.rows[0];

        // The copy is held for the student, not generally available.
        await client.query(
          `UPDATE library_book_copies
           SET status = 'issued', updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2`,
          [loan.physical_copy_id, tenantId]
        );
      } else {
        await client.query(
          `UPDATE library_book_copies
           SET status = 'available', updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2`,
          [loan.physical_copy_id, tenantId]
        );
      }
    } else {
      // No waiting reservation: the copy is available for issue.
      await client.query(
        `UPDATE library_book_copies
         SET status = 'available', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [loan.physical_copy_id, tenantId]
      );
    }

    await client.query("COMMIT");


    return res.json({
      success: true,
      message: "Book returned successfully.",
      data: {
        ...returnedResult.rows[0],
        overdueDays,
        fineForThisReturn: fine,
        finePerDay: LIBRARY_FINE_PER_DAY
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Return book error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to return book."
    });
  } finally {
    client.release();
  }
});


// GET /api/library/loans/overdue
// Register this route before any future /loans/:loanId route.
router.get("/loans/overdue", async (req, res) => {
  const tenantId = tenantIdOf(req);

  try {
    const result = await pool.query(
      `SELECT
         l.id AS loan_id,
         l.student_id,
         s.admission_number,
         s.first_name,
         s.last_name,
         l.copy_id,
         c.barcode,
         b.title AS book_title,
         l.issue_date,
         l.due_date,
         (CURRENT_DATE - l.due_date)::int AS overdue_days,
         l.fine_amount
       FROM library_loans l
       JOIN students s
         ON s.id = l.student_id AND s.tenant_id = l.tenant_id
       JOIN library_book_copies c
         ON c.id = l.copy_id AND c.tenant_id = l.tenant_id
       JOIN library_books b
         ON b.id = c.book_id AND b.tenant_id = l.tenant_id
       WHERE l.tenant_id = $1
         AND l.status = 'issued'
         AND l.due_date < CURRENT_DATE
       ORDER BY l.due_date ASC`,
      [tenantId]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows
    });
  } catch (error) {
    console.error("Overdue loans error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch overdue loans."
    });
  }
});


// GET /api/library/loans
router.get("/loans", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { status, studentId, copyId } = req.query;

  if (status && !["issued", "returned", "lost"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid loan status."
    });
  }

  if (studentId && !isPositiveId(studentId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID."
    });
  }

  if (copyId && !isPositiveId(copyId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid copy ID."
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         l.*,
         s.admission_number,
         s.first_name,
         s.last_name,
         c.barcode,
         b.title AS book_title,
         b.author AS book_author
       FROM library_loans l
       JOIN students s
         ON s.id = l.student_id AND s.tenant_id = l.tenant_id
       JOIN library_book_copies c
         ON c.id = l.copy_id AND c.tenant_id = l.tenant_id
       JOIN library_books b
         ON b.id = c.book_id AND b.tenant_id = l.tenant_id
       WHERE l.tenant_id = $1
         AND ($2::text IS NULL OR l.status = $2)
         AND ($3::bigint IS NULL OR l.student_id = $3)
         AND ($4::bigint IS NULL OR l.copy_id = $4)
       ORDER BY l.created_at DESC`,
      [
        tenantId,
        status || null,
        studentId || null,
        copyId || null
      ]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows
    });
  } catch (error) {
    console.error("List library loans error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch library loans."
    });
  }
});


// GET /api/library/students/:studentId/loans
router.get("/students/:studentId/loans", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { studentId } = req.params;

  if (!isPositiveId(studentId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID."
    });
  }

  try {
    const student = await pool.query(
      `SELECT id
       FROM students
       WHERE id = $1 AND tenant_id = $2`,
      [studentId, tenantId]
    );

    if (!student.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Student not found in your school."
      });
    }

    const result = await pool.query(
      `SELECT
         l.*,
         c.barcode,
         b.title AS book_title,
         b.author AS book_author
       FROM library_loans l
       JOIN library_book_copies c
         ON c.id = l.copy_id AND c.tenant_id = l.tenant_id
       JOIN library_books b
         ON b.id = c.book_id AND b.tenant_id = l.tenant_id
       WHERE l.tenant_id = $1 AND l.student_id = $2
       ORDER BY l.created_at DESC`,
      [tenantId, studentId]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows
    });
  } catch (error) {
    console.error("Student library history error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch student borrowing history."
    });
  }
});

/* ==========================================
   LIBRARY FINE PAYMENTS AND REPORTS
   ========================================== */

// POST /api/library/loans/:loanId/fine-payments
router.post("/loans/:loanId/fine-payments", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { loanId } = req.params;
  const { amount, paymentMethod, transactionReference, remarks } = req.body;

  const roles = req.user?.roles || [];
  if (
    !roles.includes("school_admin") &&
    !roles.includes("admin")
  ) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can record fine payments."
    });
  }

  if (!isPositiveId(loanId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid loan ID."
    });
  }

  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({
      success: false,
      message: "Payment amount must be greater than zero."
    });
  }

  const allowedMethods = [
    "cash", "upi", "bank_transfer", "card", "cheque", "other"
  ];

  if (!allowedMethods.includes(paymentMethod)) {
    return res.status(400).json({
      success: false,
      message: "Invalid payment method."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const loanResult = await client.query(
      `SELECT id, fine_amount, status
       FROM library_loans
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [loanId, tenantId]
    );

    if (!loanResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Loan not found in your school."
      });
    }

    const loan = loanResult.rows[0];

    const paidResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_paid
       FROM library_fine_payments
       WHERE tenant_id = $1 AND loan_id = $2`,
      [tenantId, loanId]
    );

    const fine = Number(loan.fine_amount);
    const paid = Number(paidResult.rows[0].total_paid);
    const outstanding = Math.max(0, fine - paid);
    const paymentAmount = Number(Number(amount).toFixed(2));

    if (paymentAmount > outstanding) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Payment exceeds the outstanding fine.",
        outstandingFine: outstanding
      });
    }

    const receivedBy = isPositiveId(req.user?.sub)
      ? Number(req.user.sub)
      : null;

    const paymentResult = await client.query(
      `INSERT INTO library_fine_payments
       (tenant_id, loan_id, amount, payment_method,
        transaction_reference, remarks, received_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        tenantId,
        loanId,
        paymentAmount,
        paymentMethod,
        typeof transactionReference === "string"
          ? transactionReference.trim() || null
          : null,
        typeof remarks === "string" ? remarks.trim() || null : null,
        receivedBy
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Fine payment recorded successfully.",
      data: {
        payment: paymentResult.rows[0],
        fineAmount: fine,
        totalPaid: Number((paid + paymentAmount).toFixed(2)),
        outstandingFine: Number((outstanding - paymentAmount).toFixed(2))
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Fine payment error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to record fine payment."
    });
  } finally {
    client.release();
  }
});


// GET /api/library/loans/:loanId/fine-payments
router.get("/loans/:loanId/fine-payments", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { loanId } = req.params;

  if (!isPositiveId(loanId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid loan ID."
    });
  }

  try {
    const loanResult = await pool.query(
      `SELECT id, fine_amount
       FROM library_loans
       WHERE id = $1 AND tenant_id = $2`,
      [loanId, tenantId]
    );

    if (!loanResult.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Loan not found."
      });
    }

    const result = await pool.query(
      `SELECT *
       FROM library_fine_payments
       WHERE tenant_id = $1 AND loan_id = $2
       ORDER BY paid_at DESC`,
      [tenantId, loanId]
    );

    const totalPaid = result.rows.reduce(
      (sum, payment) => sum + Number(payment.amount), 0
    );

    const fineAmount = Number(loanResult.rows[0].fine_amount);

    return res.json({
      success: true,
      data: {
        loanId: Number(loanId),
        fineAmount,
        totalPaid: Number(totalPaid.toFixed(2)),
        outstandingFine: Number(
          Math.max(0, fineAmount - totalPaid).toFixed(2)
        ),
        payments: result.rows
      }
    });
  } catch (error) {
    console.error("Fine payment history error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch fine payment history."
    });
  }
});


// GET /api/library/reports/fines
router.get("/reports/fines", async (req, res) => {
  const tenantId = tenantIdOf(req);

  try {
    const result = await pool.query(
      `WITH payments AS (
         SELECT loan_id, SUM(amount) AS total_paid
         FROM library_fine_payments
         WHERE tenant_id = $1
         GROUP BY loan_id
       )
       SELECT
         l.id AS loan_id,
         l.student_id,
         s.admission_number,
         s.first_name,
         s.last_name,
         b.title AS book_title,
         l.issue_date,
         l.due_date,
         l.returned_at,
         l.status AS loan_status,
         l.fine_amount,
         COALESCE(p.total_paid, 0) AS total_paid,
         GREATEST(
           l.fine_amount - COALESCE(p.total_paid, 0), 0
         ) AS outstanding_fine
       FROM library_loans l
       JOIN students s
         ON s.id = l.student_id AND s.tenant_id = l.tenant_id
       JOIN library_book_copies c
         ON c.id = l.copy_id AND c.tenant_id = l.tenant_id
       JOIN library_books b
         ON b.id = c.book_id AND b.tenant_id = l.tenant_id
       LEFT JOIN payments p ON p.loan_id = l.id
       WHERE l.tenant_id = $1
         AND l.fine_amount > 0
       ORDER BY outstanding_fine DESC, l.created_at DESC`,
      [tenantId]
    );

    const totals = result.rows.reduce(
      (acc, row) => {
        acc.assessed += Number(row.fine_amount);
        acc.paid += Number(row.total_paid);
        acc.outstanding += Number(row.outstanding_fine);
        return acc;
      },
      { assessed: 0, paid: 0, outstanding: 0 }
    );

    return res.json({
      success: true,
      totals: {
        assessed: Number(totals.assessed.toFixed(2)),
        paid: Number(totals.paid.toFixed(2)),
        outstanding: Number(totals.outstanding.toFixed(2))
      },
      count: result.rowCount,
      data: result.rows
    });
  } catch (error) {
    console.error("Fine report error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate fine report."
    });
  }
});


// GET /api/library/reports/borrowing
router.get("/reports/borrowing", async (req, res) => {
  const tenantId = tenantIdOf(req);

  try {
    const result = await pool.query(
      `SELECT
         COUNT(*)::int AS total_loans,
         COUNT(*) FILTER (WHERE status = 'issued')::int
           AS currently_issued,
         COUNT(*) FILTER (WHERE status = 'returned')::int
           AS returned,
         COUNT(*) FILTER (
           WHERE status = 'issued' AND due_date < CURRENT_DATE
         )::int AS overdue,
         COUNT(DISTINCT student_id)::int AS unique_borrowers
       FROM library_loans
       WHERE tenant_id = $1`,
      [tenantId]
    );

    const popularResult = await pool.query(
      `SELECT
         b.id AS book_id,
         b.title,
         COUNT(l.id)::int AS loan_count
       FROM library_loans l
       JOIN library_book_copies c
         ON c.id = l.copy_id AND c.tenant_id = l.tenant_id
       JOIN library_books b
         ON b.id = c.book_id AND b.tenant_id = l.tenant_id
       WHERE l.tenant_id = $1
       GROUP BY b.id, b.title
       ORDER BY loan_count DESC, b.title ASC
       LIMIT 10`,
      [tenantId]
    );

    return res.json({
      success: true,
      summary: result.rows[0],
      mostBorrowedBooks: popularResult.rows
    });
  } catch (error) {
    console.error("Borrowing report error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate borrowing report."
    });
  }
});

/* ==========================================
   LIBRARY SETTINGS
   ========================================== */

// GET /api/library/settings
router.get("/settings", async (req, res) => {
  const tenantId = tenantIdOf(req);

  if (!tenantId) {
    return res.status(401).json({
      success: false,
      message: "Tenant authentication required."
    });
  }

  try {
    const result = await pool.query(
      `SELECT tenant_id, max_active_loans, max_renewals,
              loan_period_days, reservation_hold_days, updated_at
       FROM library_settings
       WHERE tenant_id = $1`,
      [tenantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Library settings not configured for this school."
      });
    }

    return res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error("Get library settings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch library settings."
    });
  }
});


// PATCH /api/library/settings
router.patch("/settings", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const roles = req.user?.roles || [];

  if (!roles.includes("school_admin") && !roles.includes("admin")) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can update library settings."
    });
  }

  const allowed = {
    maxActiveLoans: {
      column: "max_active_loans",
      min: 1,
      max: 100
    },
    maxRenewals: {
      column: "max_renewals",
      min: 0,
      max: 20
    },
    loanPeriodDays: {
      column: "loan_period_days",
      min: 1,
      max: 365
    },
    reservationHoldDays: {
      column: "reservation_hold_days",
      min: 1,
      max: 30
    }
  };

  const updates = [];
  const values = [tenantId];

  for (const [key, config] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(req.body, key)) continue;

    const value = req.body[key];

    if (
      !Number.isInteger(value) ||
      value < config.min ||
      value > config.max
    ) {
      return res.status(400).json({
        success: false,
        message: `${key} must be an integer from ${config.min} to ${config.max}.`
      });
    }

    values.push(value);
    updates.push(`${config.column} = $${values.length}`);
  }

  if (!updates.length) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one valid setting to update."
    });
  }

  updates.push("updated_at = NOW()");

  try {
    const result = await pool.query(
      `INSERT INTO library_settings (tenant_id)
       VALUES ($1)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId]
    );

    const updated = await pool.query(
      `UPDATE library_settings
       SET ${updates.join(", ")}
       WHERE tenant_id = $1
       RETURNING tenant_id, max_active_loans, max_renewals,
                 loan_period_days, reservation_hold_days, updated_at`,
      values
    );

    return res.json({
      success: true,
      message: "Library settings updated successfully.",
      data: updated.rows[0]
    });
  } catch (error) {
    console.error("Update library settings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update library settings."
    });
  }
});

/* LIBRARY RESERVATIONS */

// 1. Create a reservation
router.post("/reservations", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { bookId, studentId } = req.body;

  if (
    !isPositiveId(bookId) ||
    !isPositiveId(studentId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid bookId and studentId are required.",
    });
  }

  try {
    const book = await pool.query(
      `SELECT id, title
       FROM library_books
       WHERE id = $1
         AND tenant_id = $2
         AND status = 'active'`,
      [bookId, tenantId]
    );

    if (book.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Active book not found.",
      });
    }

    const student = await pool.query(
      `SELECT id
       FROM students
       WHERE id = $1
         AND tenant_id = $2`,
      [studentId, tenantId]
    );

    if (student.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found in this school.",
      });
    }

    const existing = await pool.query(
      `SELECT id, status
       FROM library_reservations
       WHERE tenant_id = $1
         AND book_id = $2
         AND student_id = $3
         AND status IN ('queued', 'ready')
       LIMIT 1`,
      [tenantId, bookId, studentId]
    );

    if (existing.rowCount > 0) {
      return res.status(409).json({
        success: false,
        message: "Student already has an active reservation for this book.",
        reservation: existing.rows[0],
      });
    }

    const reservation = await pool.query(
      `INSERT INTO library_reservations
         (tenant_id, book_id, student_id, status)
       VALUES ($1, $2, $3, 'queued')
       ON CONFLICT DO NOTHING
       RETURNING id, tenant_id, book_id, student_id,
                 status, reserved_at, ready_at, expires_at`,
      [tenantId, bookId, studentId]
    );

    if (reservation.rowCount === 0) {
      return res.status(409).json({
        success: false,
        message: "An active reservation already exists.",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Book reserved successfully.",
      reservation: reservation.rows[0],
    });
  } catch (error) {
    console.error("Create reservation error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create reservation.",
    });
  }
});


// 2. List reservations for this school
router.get("/reservations", async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { status, studentId, bookId } = req.query;

  const allowedStatuses = [
    "queued",
    "ready",
    "fulfilled",
    "cancelled",
    "expired",
  ];

  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid reservation status.",
    });
  }

  if (
    studentId !== undefined &&
    !isPositiveId(studentId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid studentId.",
    });
  }

  if (
    bookId !== undefined &&
    !isPositiveId(bookId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid bookId.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         r.id,
         r.book_id AS "bookId",
         b.title AS "bookTitle",
         b.author,
         r.student_id AS "studentId",
         s.admission_number AS "admissionNumber",
         s.first_name AS "firstName",
         s.last_name AS "lastName",
         r.status,
         r.reserved_at AS "reservedAt",
         r.ready_at AS "readyAt",
         r.expires_at AS "expiresAt",
         r.fulfilled_at AS "fulfilledAt",
         r.updated_at AS "updatedAt"
       FROM library_reservations r
       JOIN library_books b
         ON b.id = r.book_id
        AND b.tenant_id = r.tenant_id
       JOIN students s
         ON s.id = r.student_id
        AND s.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1
         AND ($2::varchar IS NULL OR r.status = $2)
         AND ($3::bigint IS NULL OR r.student_id = $3)
         AND ($4::bigint IS NULL OR r.book_id = $4)
       ORDER BY r.reserved_at DESC, r.id DESC`,
      [
        tenantId,
        status || null,
        studentId || null,
        bookId || null,
      ]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      reservations: result.rows,
    });
  } catch (error) {
    console.error("List reservations error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch reservations.",
    });
  }
});


// 3. List reservations for a particular student
router.get(
  "/students/:studentId/reservations",
  async (req, res) => {
    const tenantId = tenantIdOf(req);
    const { studentId } = req.params;

    if (!isPositiveId(studentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student ID.",
      });
    }

    try {
      const result = await pool.query(
        `SELECT
           r.id,
           r.book_id AS "bookId",
           b.title AS "bookTitle",
           b.author,
           r.status,
           r.reserved_at AS "reservedAt",
           r.ready_at AS "readyAt",
           r.expires_at AS "expiresAt",
           r.fulfilled_at AS "fulfilledAt"
         FROM library_reservations r
         JOIN library_books b
           ON b.id = r.book_id
          AND b.tenant_id = r.tenant_id
         WHERE r.tenant_id = $1
           AND r.student_id = $2
         ORDER BY r.reserved_at DESC, r.id DESC`,
        [tenantId, studentId]
      );

      return res.json({
        success: true,
        count: result.rowCount,
        reservations: result.rows,
      });
    } catch (error) {
      console.error("Student reservations error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch student reservations.",
      });
    }
  }
);


// 4. Cancel a queued or ready reservation
router.patch(
  "/reservations/:reservationId/cancel",
  async (req, res) => {
    const tenantId = tenantIdOf(req);
    const { reservationId } = req.params;

    if (!isPositiveId(reservationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid reservation ID.",
      });
    }

    try {
      const result = await pool.query(
        `UPDATE library_reservations
         SET status = 'cancelled',
             updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND status IN ('queued', 'ready')
         RETURNING id, book_id AS "bookId",
                   student_id AS "studentId",
                   status, updated_at AS "updatedAt"`,
        [reservationId, tenantId]
      );

      if (result.rowCount === 0) {
        const existing = await pool.query(
          `SELECT id, status
           FROM library_reservations
           WHERE id = $1 AND tenant_id = $2`,
          [reservationId, tenantId]
        );

        if (existing.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Reservation not found.",
          });
        }

        return res.status(409).json({
          success: false,
          message: "Only queued or ready reservations can be cancelled.",
          reservation: existing.rows[0],
        });
      }

      return res.json({
        success: true,
        message: "Reservation cancelled successfully.",
        reservation: result.rows[0],
      });
    } catch (error) {
      console.error("Cancel reservation error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to cancel reservation.",
      });
    }
  }
);

module.exports = router;
