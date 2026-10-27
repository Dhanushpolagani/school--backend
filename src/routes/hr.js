const express = require("express");
const pool = require("../config/db");
const { verifyToken, requireRole } = require("../middleware/auth");
const { resolveTenant } = require("../middleware/tenant");
const { isValidId } = require("../utils/validators");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();
router.use(verifyToken, resolveTenant);

// ---------------------------------------------------------------------------
// 1. STAFF DIRECTORY & CRUD
// ---------------------------------------------------------------------------

// GET /api/hr/staff or /api/staff
router.get(["/", "/staff"], async (req, res, next) => {
  try {
    const { department, status = "active", search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT id, employee_number, first_name, last_name, email, phone,
             department, designation, joining_date, status, created_at
      FROM staff
      WHERE tenant_id = $1
    `;
    const params = [req.tenantId];

    if (status && status !== "all") {
      query += ` AND status = $${params.length + 1}`;
      params.push(status);
    }
    if (department) {
      query += ` AND department = $${params.length + 1}`;
      params.push(department);
    }
    if (search) {
      query += ` AND (first_name ILIKE $${params.length + 1} OR last_name ILIKE $${params.length + 1} OR employee_number ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY first_name, last_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    const countRes = await pool.query(
      "SELECT COUNT(*) FROM staff WHERE tenant_id = $1",
      [req.tenantId]
    );

    res.json({
      success: true,
      data: result.rows,
      meta: { total: parseInt(countRes.rows[0].count, 10), page: Number(page), limit: Number(limit) },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/hr/staff or /api/staff
router.post(["/", "/staff"], requireRole("super_admin", "school_admin", "admin", "hr_manager"), async (req, res, next) => {
  const {
    employeeNumber,
    firstName,
    lastName,
    email,
    phone,
    department,
    designation,
    joiningDate,
    salaryPaise,
    salary,
  } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ success: false, message: "First and last name are required." });
  }

  const empNum = employeeNumber || `EMP-${Date.now().toString().slice(-4)}`;
  const finalSalaryPaise = salaryPaise ? Number(salaryPaise) : (salary ? Math.round(Number(salary) * 100) : 0);

  try {
    const result = await pool.query(
      `INSERT INTO staff (
         tenant_id, employee_number, first_name, last_name, email, phone,
         department, designation, joining_date, salary_paise, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
       RETURNING *`,
      [
        req.tenantId,
        empNum,
        firstName.trim(),
        lastName.trim(),
        email || null,
        phone || null,
        department || null,
        designation || null,
        joiningDate || new Date().toISOString().slice(0, 10),
        finalSalaryPaise,
      ]
    );

    res.status(201).json({ success: true, message: "Staff created successfully.", data: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "A staff member with this employee number or email already exists." });
    }
    next(error);
  }
});

// GET /api/hr/staff/:id or /api/staff/:id
router.get(["/:id", "/staff/:id"], async (req, res, next) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid staff ID." });

  try {
    const result = await pool.query(
      `SELECT * FROM staff WHERE id = $1 AND tenant_id = $2`,
      [id, req.tenantId]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: "Staff not found." });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/hr/staff/:id or /api/staff/:id
router.put(["/:id", "/staff/:id"], requireRole("super_admin", "school_admin", "admin", "hr_manager"), async (req, res, next) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid staff ID." });

  const { firstName, lastName, email, phone, department, designation, status } = req.body;

  try {
    const result = await pool.query(
      `UPDATE staff
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           email = COALESCE($3, email),
           phone = COALESCE($4, phone),
           department = COALESCE($5, department),
           designation = COALESCE($6, designation),
           status = COALESCE($7, status),
           updated_at = NOW()
       WHERE id = $8 AND tenant_id = $9
       RETURNING *`,
      [firstName, lastName, email, phone, department, designation, status, id, req.tenantId]
    );

    if (result.rowCount === 0) return res.status(404).json({ success: false, message: "Staff not found." });
    res.json({ success: true, message: "Staff updated successfully.", data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/hr/staff/:id
router.delete(["/:id", "/staff/:id"], requireRole("super_admin", "school_admin", "admin"), async (req, res, next) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid staff ID." });

  try {
    await pool.query(
      `UPDATE staff SET status = 'inactive', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [id, req.tenantId]
    );
    res.json({ success: true, message: "Staff marked as inactive." });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 2. LEAVE MANAGEMENT
// ---------------------------------------------------------------------------

// GET /api/hr/leave
router.get("/leave", async (req, res, next) => {
  try {
    const { status, staffId } = req.query;
    let query = `
      SELECT lr.*, s.first_name, s.last_name, s.employee_number, s.department
      FROM staff_leave_requests lr
      JOIN staff s ON s.id = lr.staff_id AND s.tenant_id = lr.tenant_id
      WHERE lr.tenant_id = $1
    `;
    const params = [req.tenantId];

    if (status) {
      query += ` AND lr.status = $${params.length + 1}`;
      params.push(status);
    }
    if (staffId) {
      query += ` AND lr.staff_id = $${params.length + 1}`;
      params.push(staffId);
    }

    query += " ORDER BY lr.created_at DESC";

    const result = await pool.query(query, params);
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// POST /api/hr/leave
router.post("/leave", async (req, res, next) => {
  const { staffId, leaveType = "casual", fromDate, toDate, reason } = req.body;

  if (!fromDate || !toDate) {
    return res.status(400).json({ success: false, message: "fromDate and toDate are required." });
  }

  try {
    // Resolve staffId if not provided
    let resolvedStaffId = staffId;
    if (!resolvedStaffId) {
      const staffRes = await pool.query(
        "SELECT id FROM staff WHERE tenant_id = $1 LIMIT 1",
        [req.tenantId]
      );
      if (staffRes.rowCount > 0) resolvedStaffId = staffRes.rows[0].id;
    }

    const days = Math.max(1, Math.ceil((new Date(toDate) - new Date(fromDate)) / (1000 * 60 * 60 * 24)) + 1);

    const result = await pool.query(
      `INSERT INTO staff_leave_requests (tenant_id, staff_id, leave_type, from_date, to_date, days_count, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [req.tenantId, resolvedStaffId, leaveType, fromDate, toDate, days, reason || null]
    );

    res.status(201).json({ success: true, message: "Leave request submitted.", data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/hr/leave/:id/approve
router.put("/leave/:id/approve", requireRole("super_admin", "school_admin", "admin", "hr_manager"), async (req, res, next) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE staff_leave_requests
       SET status = 'approved', approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, req.tenantId]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: "Leave request not found." });
    res.json({ success: true, message: "Leave request approved.", data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// PUT /api/hr/leave/:id/reject
router.put("/leave/:id/reject", requireRole("super_admin", "school_admin", "admin", "hr_manager"), async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;
  try {
    const result = await pool.query(
      `UPDATE staff_leave_requests
       SET status = 'rejected', rejection_reason = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [reason || null, id, req.tenantId]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: "Leave request not found." });
    res.json({ success: true, message: "Leave request rejected.", data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 3. STAFF ATTENDANCE
// ---------------------------------------------------------------------------
router.get("/attendance", async (req, res, next) => {
  const { date = new Date().toISOString().slice(0, 10) } = req.query;
  try {
    const result = await pool.query(
      `SELECT s.id AS staff_id, s.employee_number, s.first_name, s.last_name, s.department
       FROM staff s
       WHERE s.tenant_id = $1 AND s.status = 'active'
       ORDER BY s.department, s.first_name`,
      [req.tenantId]
    );
    res.json({ success: true, date, count: result.rowCount, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// Attach staff and leave sub-routers for modular compatibility
try {
  const staffRouter = require("../services/staffRouter");
  router.staffRouter = staffRouter;
} catch (e) {
  console.warn("Could not load staffRouter:", e.message);
}

try {
  const leaveRouter = require("../services/leaveRouter");
  router.leaveRouter = leaveRouter;
} catch (e) {
  console.warn("Could not load leaveRouter:", e.message);
}

module.exports = router;
