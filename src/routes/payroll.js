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

// GET /api/payroll/summary
// High-level statistics for payroll
router.get("/summary", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const currentYear = new Date().getFullYear();

    const summaryResult = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM staff WHERE tenant_id = $1 AND status = 'active') AS active_staff_count,
         (SELECT COUNT(*) FROM staff_salary_structures WHERE tenant_id = $1) AS configured_structures_count,
         (SELECT COUNT(*) FROM payroll_runs WHERE tenant_id = $1) AS total_runs,
         (SELECT COUNT(*) FROM payroll_runs WHERE tenant_id = $1 AND status = 'draft') AS draft_runs,
         (SELECT COUNT(*) FROM payroll_runs WHERE tenant_id = $1 AND status = 'generated') AS generated_runs,
         (SELECT COUNT(*) FROM payroll_runs WHERE tenant_id = $1 AND status = 'approved') AS approved_runs,
         (SELECT COUNT(*) FROM payroll_runs WHERE tenant_id = $1 AND status = 'paid') AS paid_runs,
         (SELECT COALESCE(SUM(total_net_paise), 0) FROM payroll_runs WHERE tenant_id = $1 AND year = $2 AND status = 'paid') AS ytd_paid_paise`,
      [tenantId, currentYear]
    );

    res.json({
      success: true,
      data: summaryResult.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/payroll/components
// List salary components (Earnings & Deductions)
router.get("/components", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT * FROM payroll_salary_components
       WHERE tenant_id = $1
       ORDER BY type ASC, name ASC`,
      [tenantId]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/payroll/components
// Create a new salary component
router.post("/components", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const {
    name,
    type,
    calculationType = "fixed",
    percentageOf,
    defaultAmountPaise = 0,
  } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Component name is required.",
    });
  }

  if (!type || !["earning", "deduction"].includes(type)) {
    return res.status(400).json({
      success: false,
      message: "Component type must be 'earning' or 'deduction'.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO payroll_salary_components (
         tenant_id,
         name,
         type,
         calculation_type,
         percentage_of,
         default_amount_paise
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        tenantId,
        name.trim(),
        type,
        calculationType,
        percentageOf?.trim() || null,
        Math.max(0, parseInt(defaultAmountPaise, 10) || 0),
      ]
    );

    await logAudit(req, {
      action: "CREATE",
      entityType: "payroll_component",
      entityId: result.rows[0].id,
      details: { name, type },
    });

    res.status(201).json({
      success: true,
      message: "Salary component created.",
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A component with this name already exists in your school.",
      });
    }
    next(error);
  }
});

// GET /api/payroll/structures
// List staff salary structures
router.get("/structures", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT
         sss.*,
         s.employee_number,
         s.first_name,
         s.last_name,
         s.department,
         s.designation
       FROM staff_salary_structures sss
       JOIN staff s ON s.tenant_id = sss.tenant_id AND s.id = sss.staff_id
       WHERE sss.tenant_id = $1
       ORDER BY s.first_name ASC`,
      [tenantId]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/payroll/structures/:staffId
// Get salary structure for a specific staff member
router.get("/structures/:staffId", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { staffId } = req.params;
  if (!isPositiveId(staffId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid staff ID format.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         sss.*,
         s.employee_number,
         s.first_name,
         s.last_name,
         s.department,
         s.designation,
         s.salary_paise AS staff_base_salary
       FROM staff s
       LEFT JOIN staff_salary_structures sss ON sss.tenant_id = s.tenant_id AND sss.staff_id = s.id
       WHERE s.tenant_id = $1 AND s.id = $2`,
      [tenantId, staffId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found.",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/payroll/structures
// Assign or update a staff member's salary structure
router.post("/structures", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const {
    staffId,
    basicSalaryPaise,
    components = [],
    bankName,
    bankAccountNumber,
    bankIfsc,
    panNumber,
    effectiveFrom,
  } = req.body;

  if (!staffId || !isPositiveId(staffId)) {
    return res.status(400).json({
      success: false,
      message: "Valid staffId is required.",
    });
  }

  if (basicSalaryPaise === undefined || Number(basicSalaryPaise) < 0) {
    return res.status(400).json({
      success: false,
      message: "basicSalaryPaise must be a non-negative number.",
    });
  }

  try {
    // Check staff exists
    const staffCheck = await pool.query(
      `SELECT id, first_name, last_name FROM staff WHERE tenant_id = $1 AND id = $2`,
      [tenantId, staffId]
    );
    if (staffCheck.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found.",
      });
    }

    const result = await pool.query(
      `INSERT INTO staff_salary_structures (
         tenant_id,
         staff_id,
         basic_salary_paise,
         components,
         bank_name,
         bank_account_number,
         bank_ifsc,
         pan_number,
         effective_from,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (tenant_id, staff_id)
       DO UPDATE SET
         basic_salary_paise = EXCLUDED.basic_salary_paise,
         components = EXCLUDED.components,
         bank_name = EXCLUDED.bank_name,
         bank_account_number = EXCLUDED.bank_account_number,
         bank_ifsc = EXCLUDED.bank_ifsc,
         pan_number = EXCLUDED.pan_number,
         effective_from = EXCLUDED.effective_from,
         updated_at = NOW()
       RETURNING *`,
      [
        tenantId,
        staffId,
        basicSalaryPaise,
        JSON.stringify(Array.isArray(components) ? components : []),
        bankName?.trim() || null,
        bankAccountNumber?.trim() || null,
        bankIfsc?.trim() || null,
        panNumber?.trim() || null,
        effectiveFrom || new Date(),
      ]
    );

    // Also sync base salary in staff table if relevant
    await pool.query(
      `UPDATE staff SET salary_paise = $1, updated_at = NOW() WHERE tenant_id = $2 AND id = $3`,
      [basicSalaryPaise, tenantId, staffId]
    );

    await logAudit(req, {
      action: "UPDATE",
      entityType: "salary_structure",
      entityId: staffId,
      details: { basicSalaryPaise, componentsCount: components.length },
    });

    res.json({
      success: true,
      message: "Salary structure configured successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/payroll/runs
// List payroll runs
router.get("/runs", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const { year } = req.query;
    const conditions = ["tenant_id = $1"];
    const params = [tenantId];

    if (year && !isNaN(year)) {
      conditions.push(`year = $2`);
      params.push(parseInt(year, 10));
    }

    const result = await pool.query(
      `SELECT * FROM payroll_runs
       WHERE ${conditions.join(" AND ")}
       ORDER BY year DESC, month DESC`,
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

// POST /api/payroll/runs
// Initialize a payroll run for a month/year
router.post("/runs", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { month, year, title } = req.body;

  if (!month || month < 1 || month > 12) {
    return res.status(400).json({
      success: false,
      message: "Valid month (1-12) is required.",
    });
  }

  if (!year || year < 2000) {
    return res.status(400).json({
      success: false,
      message: "Valid year is required.",
    });
  }

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const runTitle = title?.trim() || `Payroll ${monthNames[month - 1]} ${year}`;

  try {
    const result = await pool.query(
      `INSERT INTO payroll_runs (
         tenant_id,
         month,
         year,
         title,
         status,
         processed_by
       )
       VALUES ($1, $2, $3, $4, 'draft', $5)
       RETURNING *`,
      [
        tenantId,
        month,
        year,
        runTitle,
        req.user?.id ? Number(req.user.id) : null,
      ]
    );

    await logAudit(req, {
      action: "CREATE",
      entityType: "payroll_run",
      entityId: result.rows[0].id,
      details: { month, year, title: runTitle },
    });

    res.status(201).json({
      success: true,
      message: "Payroll run created.",
      data: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A payroll run already exists for this month and year.",
      });
    }
    next(error);
  }
});

// POST /api/payroll/runs/:id/generate
// Automatically calculate salaries & generate payslips for all active staff
router.post("/runs/:id/generate", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const runRes = await client.query(
      `SELECT * FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id]
    );

    if (runRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Payroll run not found.",
      });
    }

    const run = runRes.rows[0];
    if (run.status === "paid") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Cannot re-generate a paid payroll run.",
      });
    }

    // Delete existing payslips for this draft run to regenerate cleanly
    await client.query(
      `DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [tenantId, id]
    );

    // Fetch all active staff with optional salary structures
    const staffRes = await client.query(
      `SELECT
         s.id,
         s.employee_number,
         s.first_name,
         s.last_name,
         s.salary_paise AS base_salary,
         sss.basic_salary_paise,
         sss.components,
         sss.bank_account_number
       FROM staff s
       LEFT JOIN staff_salary_structures sss ON sss.tenant_id = s.tenant_id AND sss.staff_id = s.id
       WHERE s.tenant_id = $1 AND s.status = 'active'
       ORDER BY s.id ASC`,
      [tenantId]
    );

    const staffList = staffRes.rows;
    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;
    let slipIndex = 1;

    for (const staffMember of staffList) {
      const basicSalary = Number(staffMember.basic_salary_paise || staffMember.base_salary || 0);

      // Parse custom components if present
      let components = [];
      if (staffMember.components) {
        components = typeof staffMember.components === "string"
          ? JSON.parse(staffMember.components)
          : staffMember.components;
      }

      let allowances = 0;
      let deductions = 0;
      const earningsDetails = [{ name: "Basic Salary", amount_paise: basicSalary }];
      const deductionsDetails = [];

      for (const comp of components) {
        const amt = Number(comp.amount_paise || comp.amount || 0);
        if (comp.type === "earning") {
          allowances += amt;
          earningsDetails.push({ name: comp.name, amount_paise: amt });
        } else if (comp.type === "deduction") {
          deductions += amt;
          deductionsDetails.push({ name: comp.name, amount_paise: amt });
        }
      }

      const gross = basicSalary + allowances;
      const net = Math.max(0, gross - deductions);

      totalGross += gross;
      totalDeductions += deductions;
      totalNet += net;

      const payslipNumber = `PS-${run.year}${String(run.month).padStart(2, "0")}-${String(slipIndex).padStart(4, "0")}`;
      slipIndex++;

      await client.query(
        `INSERT INTO payslips (
           tenant_id,
           payroll_run_id,
           staff_id,
           payslip_number,
           month,
           year,
           basic_paise,
           gross_paise,
           total_deductions_paise,
           net_paise,
           earnings_details,
           deductions_details,
           payment_status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'unpaid')`,
        [
          tenantId,
          id,
          staffMember.id,
          payslipNumber,
          run.month,
          run.year,
          basicSalary,
          gross,
          deductions,
          net,
          JSON.stringify(earningsDetails),
          JSON.stringify(deductionsDetails),
        ]
      );
    }

    // Update payroll run
    const updatedRunRes = await client.query(
      `UPDATE payroll_runs
       SET
         status = 'generated',
         total_staff_count = $1,
         total_gross_paise = $2,
         total_deductions_paise = $3,
         total_net_paise = $4,
         processed_at = NOW(),
         processed_by = $5,
         updated_at = NOW()
       WHERE tenant_id = $6 AND id = $7
       RETURNING *`,
      [
        staffList.length,
        totalGross,
        totalDeductions,
        totalNet,
        req.user?.id ? Number(req.user.id) : null,
        tenantId,
        id,
      ]
    );

    await client.query("COMMIT");

    await logAudit(req, {
      action: "UPDATE",
      entityType: "payroll_run",
      entityId: id,
      details: {
        action: "generate_payslips",
        staffCount: staffList.length,
        totalNet,
      },
    });

    res.json({
      success: true,
      message: `Payslips generated for ${staffList.length} staff members.`,
      data: updatedRunRes.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

// GET /api/payroll/runs/:id
// Get details of payroll run and its payslips
router.get("/runs/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const runResult = await pool.query(
      `SELECT * FROM payroll_runs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id]
    );

    if (runResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Payroll run not found.",
      });
    }

    const payslipsResult = await pool.query(
      `SELECT
         p.*,
         s.employee_number,
         s.first_name,
         s.last_name,
         s.department,
         s.designation
       FROM payslips p
       JOIN staff s ON s.tenant_id = p.tenant_id AND s.id = p.staff_id
       WHERE p.tenant_id = $1 AND p.payroll_run_id = $2
       ORDER BY s.first_name ASC`,
      [tenantId, id]
    );

    const run = runResult.rows[0];
    run.payslips = payslipsResult.rows;

    res.json({
      success: true,
      data: run,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/payroll/runs/:id/status
// Update status of payroll run (approve, cancel)
router.patch("/runs/:id/status", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { status } = req.body;

  if (!["draft", "approved", "cancelled"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Status must be 'draft', 'approved', or 'cancelled'.",
    });
  }

  try {
    const isApproved = status === "approved";

    const result = await pool.query(
      `UPDATE payroll_runs
       SET
         status = $1,
         approved_by = CASE WHEN $2 THEN $3 ELSE approved_by END,
         approved_at = CASE WHEN $2 THEN NOW() ELSE approved_at END,
         updated_at = NOW()
       WHERE tenant_id = $4 AND id = $5
       RETURNING *`,
      [
        status,
        isApproved,
        req.user?.id ? Number(req.user.id) : null,
        tenantId,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Payroll run not found.",
      });
    }

    await logAudit(req, {
      action: "STATUS_CHANGE",
      entityType: "payroll_run",
      entityId: id,
      details: { newStatus: status },
    });

    res.json({
      success: true,
      message: `Payroll run status updated to ${status}.`,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/payroll/runs/:id/disburse
// Mark payroll run and payslips as paid
router.post("/runs/:id/disburse", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { paymentMethod = "bank_transfer", paymentReference, paymentDate } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const runRes = await client.query(
      `SELECT * FROM payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id]
    );

    if (runRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Payroll run not found.",
      });
    }

    const run = runRes.rows[0];
    if (run.status === "paid") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Payroll run has already been paid.",
      });
    }

    const pDate = paymentDate || new Date();

    // 1. Update payslips
    await client.query(
      `UPDATE payslips
       SET
         payment_status = 'paid',
         payment_method = $1,
         payment_reference = $2,
         paid_at = NOW()
       WHERE tenant_id = $3 AND payroll_run_id = $4`,
      [paymentMethod, paymentReference?.trim() || null, tenantId, id]
    );

    // 2. Update run
    const updatedRunRes = await client.query(
      `UPDATE payroll_runs
       SET
         status = 'paid',
         payment_date = $1,
         updated_at = NOW()
       WHERE tenant_id = $2 AND id = $3
       RETURNING *`,
      [pDate, tenantId, id]
    );

    await client.query("COMMIT");

    await logAudit(req, {
      action: "UPDATE",
      entityType: "payroll_run",
      entityId: id,
      details: {
        action: "disburse_payroll",
        paymentMethod,
        paymentReference,
      },
    });

    res.json({
      success: true,
      message: "Payroll disbursed successfully.",
      data: updatedRunRes.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

// GET /api/payroll/payslips/:id
// View a single payslip
router.get("/payslips/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT
         p.*,
         s.employee_number,
         s.first_name,
         s.last_name,
         s.department,
         s.designation,
         s.email AS staff_email,
         sss.bank_name,
         sss.bank_account_number,
         sss.bank_ifsc,
         sss.pan_number,
         t.name AS school_name
       FROM payslips p
       JOIN staff s ON s.tenant_id = p.tenant_id AND s.id = p.staff_id
       LEFT JOIN staff_salary_structures sss ON sss.tenant_id = p.tenant_id AND sss.staff_id = s.id
       JOIN tenants t ON t.id = p.tenant_id
       WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Payslip not found.",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/payroll/my-payslips
// View payslips for the logged-in user
router.get("/my-payslips", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    // Match staff via user's email
    const userRes = await pool.query(
      `SELECT email FROM users WHERE tenant_id = $1 AND id = $2`,
      [tenantId, req.user.id]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const email = userRes.rows[0].email;
    const staffRes = await pool.query(
      `SELECT id FROM staff WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email]
    );

    if (staffRes.rowCount === 0) {
      return res.json({
        success: true,
        data: [],
        message: "No staff record associated with this user email.",
      });
    }

    const staffId = staffRes.rows[0].id;

    const payslips = await pool.query(
      `SELECT * FROM payslips
       WHERE tenant_id = $1 AND staff_id = $2
       ORDER BY year DESC, month DESC`,
      [tenantId, staffId]
    );

    res.json({
      success: true,
      data: payslips.rows,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
