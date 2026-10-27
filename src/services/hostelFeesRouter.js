
const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

const isSchoolAdmin = (req) =>
  Array.isArray(req.user?.roles) &&
  req.user.roles.includes("school_admin");

const validId = (value) => /^[1-9]\d*$/.test(String(value ?? ""));

const validDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
};

const validMonth = (value) =>
  validDate(value) && value.endsWith("-01");

const validAmount = (value, allowZero = false) => {
  if (value === null || value === undefined || value === "") return false;

  const amount = Number(value);
  return Number.isFinite(amount) &&
    amount >= (allowZero ? 0 : 0.01) &&
    amount <= 99999999.99 &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 0.00001;
};

const validText = (value, maxLength) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maxLength;

const validNullableText = (value, maxLength) =>
  value === null ||
  (typeof value === "string" && value.length <= maxLength);

const validPaymentMethod = (value) =>
  [
    "cash",
    "upi",
    "bank_transfer",
    "card",
    "cheque",
    "other"
  ].includes(value);

const databaseError = (res, error, action) => {
  if (error.code === "23505") {
    return res.status(409).json({
      success: false,
      message: "A record already exists for these details."
    });
  }

  if (error.code === "23503") {
    return res.status(400).json({
      success: false,
      message: "The referenced record does not exist or is invalid."
    });
  }

  console.error(`${action}:`, error);

  return res.status(500).json({
    success: false,
    message: `Unable to ${action.toLowerCase()}.`
  });
};

// =====================================================
// 1. GENERATE MONTHLY INVOICES IN BULK
// POST /api/hostel-fees/invoices/generate-month
//
// billingMonth must be the first day of the month.
// Optional hostelId limits generation to one hostel.
// Existing invoices are not duplicated.
// =====================================================
router.post("/invoices/generate-month", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can generate invoices."
    });
  }

  const { billingMonth, dueDate, hostelId } = req.body;

  if (
    !validMonth(billingMonth) ||
    !validDate(dueDate) ||
    dueDate < billingMonth ||
    (hostelId !== undefined &&
      hostelId !== null &&
      hostelId !== "" &&
      !validId(hostelId))
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid billingMonth (YYYY-MM-01), dueDate, and optional hostelId."
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO hostel_fee_invoices (
         tenant_id,
         allocation_id,
         billing_month,
         amount_due,
         due_date,
         status,
         created_by
       )
       SELECT
         a.tenant_id,
         a.id,
         $2::date,
         a.monthly_fee,
         $3::date,
         'unpaid',
         $4
       FROM hostel_allocations a
       WHERE a.tenant_id = $1
         AND a.status <> 'cancelled'
         AND a.monthly_fee > 0
         AND a.allocated_on <=
             ($2::date + INTERVAL '1 month - 1 day')::date
         AND (
           a.vacated_on IS NULL OR a.vacated_on >= $2::date
         )
         AND (
           $5::bigint IS NULL OR a.hostel_id = $5
         )
       ON CONFLICT (tenant_id, allocation_id, billing_month)
       DO NOTHING
       RETURNING id, allocation_id, billing_month, amount_due`,
      [
        req.user.tenantId,
        billingMonth,
        dueDate,
        req.user.sub,
        hostelId || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Monthly invoice generation completed.",
      createdCount: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    return databaseError(res, error, "Generate monthly invoices");
  }
});

// =====================================================
// 2. CREATE ONE INVOICE
// POST /api/hostel-fees/invoices
//
// amountDue defaults to the allocation's monthly fee.
// =====================================================
router.post("/invoices", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can create invoices."
    });
  }

  const {
    allocationId,
    billingMonth,
    dueDate,
    amountDue,
    remarks = null
  } = req.body;

  if (
    !validId(allocationId) ||
    !validMonth(billingMonth) ||
    !validDate(dueDate) ||
    dueDate < billingMonth ||
    (amountDue !== undefined && !validAmount(amountDue)) ||
    !validNullableText(remarks, 2000)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid allocation, billing month, due date, amount, or remarks."
    });
  }

  try {
    const allocationResult = await pool.query(
      `SELECT id, monthly_fee
       FROM hostel_allocations
       WHERE tenant_id = $1
         AND id = $2
         AND status <> 'cancelled'
         AND allocated_on <=
             ($3::date + INTERVAL '1 month - 1 day')::date
         AND (vacated_on IS NULL OR vacated_on >= $3::date)`,
      [req.user.tenantId, allocationId, billingMonth]
    );

    if (allocationResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No valid hostel allocation overlaps this billing month."
      });
    }

    const amount = amountDue === undefined
      ? Number(allocationResult.rows[0].monthly_fee)
      : Number(amountDue);

    if (!validAmount(amount)) {
      return res.status(400).json({
        success: false,
        message: "The invoice amount must be greater than zero."
      });
    }

    const result = await pool.query(
      `INSERT INTO hostel_fee_invoices (
         tenant_id,
         allocation_id,
         billing_month,
         amount_due,
         due_date,
         remarks,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.user.tenantId,
        allocationId,
        billingMonth,
        amount,
        dueDate,
        remarks,
        req.user.sub
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Hostel fee invoice created successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    return databaseError(res, error, "Create hostel invoice");
  }
});

// =====================================================
// SHARED INVOICE LIST QUERY
// =====================================================
const invoiceSelect = `
  SELECT
    i.id AS invoice_id,
    i.allocation_id,
    i.billing_month,
    i.amount_due,
    i.due_date,
    i.status,
    i.remarks,
    i.created_at,
    s.id AS student_id,
    s.admission_number,
    s.first_name,
    s.last_name,
    s.class_name,
    s.section,
    h.id AS hostel_id,
    h.name AS hostel_name,
    r.id AS room_id,
    r.room_number,
    payments.total_paid,
    CASE
      WHEN i.status = 'waived' THEN 0::numeric
      ELSE GREATEST(i.amount_due - payments.total_paid, 0)
    END AS balance_due
  FROM hostel_fee_invoices i
  JOIN hostel_allocations a
    ON a.id = i.allocation_id
   AND a.tenant_id = i.tenant_id
  JOIN students s
    ON s.id = a.student_id
   AND s.tenant_id = a.tenant_id
  JOIN hostels h
    ON h.id = a.hostel_id
   AND h.tenant_id = a.tenant_id
  JOIN hostel_rooms r
    ON r.id = a.room_id
   AND r.tenant_id = a.tenant_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(p.amount_paid), 0)::numeric AS total_paid
    FROM hostel_fee_payments p
    WHERE p.tenant_id = i.tenant_id
      AND p.invoice_id = i.id
  ) payments ON TRUE
`;

// =====================================================
// 3. LIST INVOICES
// GET /api/hostel-fees/invoices
// Optional filters: status, billingMonth, studentId, hostelId
// =====================================================
router.get("/invoices", async (req, res) => {
  const { status, billingMonth, studentId, hostelId } = req.query;

  if (
    (status !== undefined &&
      !["unpaid", "partially_paid", "paid", "waived"].includes(status)) ||
    (billingMonth !== undefined && !validMonth(billingMonth)) ||
    (studentId !== undefined && !validId(studentId)) ||
    (hostelId !== undefined && !validId(hostelId))
  ) {
    return res.status(400).json({
      success: false,
      message: "One or more invoice filters are invalid."
    });
  }

  const conditions = ["i.tenant_id = $1"];
  const values = [req.user.tenantId];

  for (const [key, column] of [
    ["status", "i.status"],
    ["billingMonth", "i.billing_month"],
    ["studentId", "s.id"],
    ["hostelId", "h.id"]
  ]) {
    if (req.query[key] !== undefined) {
      values.push(req.query[key]);
      conditions.push(`${column} = $${values.length}`);
    }
  }

  try {
    const result = await pool.query(
      `${invoiceSelect}
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.billing_month DESC, i.id DESC`,
      values
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    return databaseError(res, error, "Retrieve invoices");
  }
});

// =====================================================
// 4. STUDENT FEE HISTORY
// GET /api/hostel-fees/students/:studentId/fees
// =====================================================
router.get("/students/:studentId/fees", async (req, res) => {
  const { studentId } = req.params;

  if (!validId(studentId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid student ID."
    });
  }

  try {
    const result = await pool.query(
      `${invoiceSelect}
       WHERE i.tenant_id = $1 AND s.id = $2
       ORDER BY i.billing_month DESC, i.id DESC`,
      [req.user.tenantId, studentId]
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    return databaseError(res, error, "Retrieve student fee history");
  }
});

// =====================================================
// 5. OUTSTANDING BALANCE REPORT
// GET /api/hostel-fees/reports/outstanding
// Optional: ?hostelId=1
// =====================================================
router.get("/reports/outstanding", async (req, res) => {
  const { hostelId } = req.query;

  if (hostelId !== undefined && !validId(hostelId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid hostel ID."
    });
  }

  try {
    const values = [req.user.tenantId];
    let filter = "";

    if (hostelId !== undefined) {
      values.push(hostelId);
      filter = ` AND h.id = $${values.length}`;
    }

    const result = await pool.query(
      `${invoiceSelect}
       WHERE i.tenant_id = $1
         AND i.status <> 'waived'
         AND payments.total_paid < i.amount_due
         ${filter}
       ORDER BY i.due_date ASC, s.last_name, s.first_name`,
      values
    );

    const totalOutstanding = result.rows.reduce(
      (total, row) => total + Number(row.balance_due),
      0
    );

    return res.json({
      success: true,
      invoiceCount: result.rows.length,
      totalOutstanding: Number(totalOutstanding.toFixed(2)),
      data: result.rows
    });
  } catch (error) {
    return databaseError(res, error, "Retrieve outstanding balances");
  }
});

// =====================================================
// 6. RECORD FULL OR PARTIAL PAYMENT
// POST /api/hostel-fees/invoices/:invoiceId/payments
// =====================================================
router.post("/invoices/:invoiceId/payments", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can record hostel fee payments."
    });
  }

  const { invoiceId } = req.params;
  const {
    amountPaid,
    paymentDate,
    paymentMethod,
    transactionReference = null,
    remarks = null
  } = req.body;

  if (
    !validId(invoiceId) ||
    !validAmount(amountPaid) ||
    (paymentDate !== undefined && !validDate(paymentDate)) ||
    !validPaymentMethod(paymentMethod) ||
    !validNullableText(transactionReference, 120) ||
    !validNullableText(remarks, 2000)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid payment details."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      `SELECT id, amount_due, status
       FROM hostel_fee_invoices
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [req.user.tenantId, invoiceId]
    );

    if (invoiceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Invoice not found."
      });
    }

    const invoice = invoiceResult.rows[0];

    if (invoice.status === "waived" || invoice.status === "paid") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This invoice is already paid or waived."
      });
    }

    const paymentTotalResult = await client.query(
      `SELECT COALESCE(SUM(amount_paid), 0)::numeric AS total_paid
       FROM hostel_fee_payments
       WHERE tenant_id = $1 AND invoice_id = $2`,
      [req.user.tenantId, invoiceId]
    );

    const alreadyPaidCents = Math.round(
      Number(paymentTotalResult.rows[0].total_paid) * 100
    );
    const dueCents = Math.round(Number(invoice.amount_due) * 100);
    const newPaymentCents = Math.round(Number(amountPaid) * 100);
    const remainingCents = dueCents - alreadyPaidCents;

    if (newPaymentCents > remainingCents) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Payment exceeds the remaining balance of ${(remainingCents / 100).toFixed(2)}.`,
        remainingBalance: (remainingCents / 100).toFixed(2)
      });
    }

    const paymentResult = await client.query(
      `INSERT INTO hostel_fee_payments (
         tenant_id,
         invoice_id,
         amount_paid,
         payment_date,
         payment_method,
         transaction_reference,
         remarks,
         received_by
       )
       VALUES (
         $1, $2, $3, COALESCE($4::date, CURRENT_DATE),
         $5, $6, $7, $8
       )
       RETURNING *`,
      [
        req.user.tenantId,
        invoiceId,
        Number(amountPaid),
        paymentDate || null,
        paymentMethod,
        transactionReference,
        remarks,
        req.user.sub
      ]
    );

    const totalPaidCents = alreadyPaidCents + newPaymentCents;
    const newStatus = totalPaidCents >= dueCents
      ? "paid"
      : "partially_paid";

    await client.query(
      `UPDATE hostel_fee_invoices
       SET status = $3, updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [req.user.tenantId, invoiceId, newStatus]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Payment recorded successfully.",
      data: {
        payment: paymentResult.rows[0],
        totalPaid: (totalPaidCents / 100).toFixed(2),
        amountDue: (dueCents / 100).toFixed(2),
        balanceDue: ((dueCents - totalPaidCents) / 100).toFixed(2),
        invoiceStatus: newStatus
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return databaseError(res, error, "Record hostel fee payment");
  } finally {
    client.release();
  }
});

// =====================================================
// 7. LIST PAYMENTS FOR AN INVOICE
// GET /api/hostel-fees/invoices/:invoiceId/payments
// =====================================================
router.get("/invoices/:invoiceId/payments", async (req, res) => {
  const { invoiceId } = req.params;

  if (!validId(invoiceId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid invoice ID."
    });
  }

  try {
    const invoiceResult = await pool.query(
      `SELECT id
       FROM hostel_fee_invoices
       WHERE tenant_id = $1 AND id = $2`,
      [req.user.tenantId, invoiceId]
    );

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found."
      });
    }

    const result = await pool.query(
      `SELECT
         id,
         invoice_id,
         amount_paid,
         payment_date,
         payment_method,
         transaction_reference,
         remarks,
         received_by,
         created_at
       FROM hostel_fee_payments
       WHERE tenant_id = $1 AND invoice_id = $2
       ORDER BY payment_date DESC, id DESC`,
      [req.user.tenantId, invoiceId]
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    return databaseError(res, error, "Retrieve invoice payments");
  }
});

// =====================================================
// 8. WAIVE AN UNPAID INVOICE
// PATCH /api/hostel-fees/invoices/:invoiceId/waive
// Waiving invoices with existing payments is not allowed.
// =====================================================
router.patch("/invoices/:invoiceId/waive", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can waive invoices."
    });
  }

  const { invoiceId } = req.params;
  const { reason } = req.body;

  if (
    !validId(invoiceId) ||
    (reason !== undefined && !validText(reason, 500))
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid invoice ID or waiver reason."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      `SELECT id, status
       FROM hostel_fee_invoices
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [req.user.tenantId, invoiceId]
    );

    if (invoiceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Invoice not found."
      });
    }

    if (["paid", "waived"].includes(invoiceResult.rows[0].status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This invoice is already paid or waived."
      });
    }

    const payments = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM hostel_fee_payments
         WHERE tenant_id = $1 AND invoice_id = $2
       ) AS has_payments`,
      [req.user.tenantId, invoiceId]
    );

    if (payments.rows[0].has_payments) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "An invoice with payments cannot be waived. Resolve the payments first."
      });
    }

    const result = await client.query(
      `UPDATE hostel_fee_invoices
       SET status = 'waived',
           remarks = COALESCE($3, remarks),
           updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [req.user.tenantId, invoiceId, reason || null]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Invoice waived successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return databaseError(res, error, "Waive hostel fee invoice");
  } finally {
    client.release();
  }
});

// =====================================================
// 9. GET ONE INVOICE
// GET /api/hostel-fees/invoices/:invoiceId
// =====================================================
router.get("/invoices/:invoiceId", async (req, res) => {
  const { invoiceId } = req.params;

  if (!validId(invoiceId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid invoice ID."
    });
  }

  try {
    const result = await pool.query(
      `${invoiceSelect}
       WHERE i.tenant_id = $1 AND i.id = $2`,
      [req.user.tenantId, invoiceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found."
      });
    }

    return res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    return databaseError(res, error, "Retrieve invoice");
  }
});

module.exports = router;
