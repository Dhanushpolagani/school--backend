
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const router = express.Router();

// Authenticate using the existing access-token cookie.
function authenticateToken(req, res, next) {
  const token = req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET is not configured");
    return res.status(500).json({
      success: false,
      message: "Authentication configuration error",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.sub || !decoded.tenantId || !decoded.roles) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    req.user = {
      id: decoded.sub,
      tenantId: decoded.tenantId,
      roles: decoded.roles,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
}

router.use(authenticateToken);

// POST /api/staff - Create a staff member
router.post("/", async (req, res) => {
  try {
    const {
      employeeNumber,
      firstName,
      lastName,
      email,
      phone,
      department,
      designation,
      employmentType = "full_time",
      joiningDate,
      salaryPaise = 0,
      address,
    } = req.body;

    if (
      typeof employeeNumber !== "string" ||
      !employeeNumber.trim() ||
      employeeNumber.trim().length > 50
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid employeeNumber is required",
      });
    }

    if (
      typeof firstName !== "string" ||
      !firstName.trim() ||
      firstName.trim().length > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid firstName is required",
      });
    }

    if (
      typeof joiningDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(joiningDate)
    ) {
      return res.status(400).json({
        success: false,
        message: "joiningDate must use YYYY-MM-DD format",
      });
    }

    const parsedDate = new Date(`${joiningDate}T00:00:00Z`);

    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== joiningDate
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid joiningDate",
      });
    }

    if (
      !Number.isSafeInteger(salaryPaise) ||
      salaryPaise < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "salaryPaise must be a non-negative integer",
      });
    }

    const validEmploymentTypes = [
      "full_time",
      "part_time",
      "contract",
      "temporary",
    ];

    if (!validEmploymentTypes.includes(employmentType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid employmentType",
      });
    }

    if (
      email != null &&
      (typeof email !== "string" ||
        email.length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address",
      });
    }

    const result = await pool.query(
      `INSERT INTO staff (
        tenant_id,
        employee_number,
        first_name,
        last_name,
        email,
        phone,
        department,
        designation,
        employment_type,
        joining_date,
        salary_paise,
        address
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      )
      RETURNING *`,
      [
        req.user.tenantId,
        employeeNumber.trim(),
        firstName.trim(),
        lastName?.trim() || null,
        email?.trim().toLowerCase() || null,
        phone?.trim() || null,
        department?.trim() || null,
        designation?.trim() || null,
        employmentType,
        joiningDate,
        salaryPaise,
        address?.trim() || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Staff member created successfully",
      staff: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Employee number already exists for this school",
      });
    }

    console.error("Create staff error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create staff member",
    });
  }
});

// GET /api/staff - List staff members
router.get("/", async (req, res) => {
  try {
    const { status, department } = req.query;

    const validStatuses = [
      "active",
      "inactive",
      "on_leave",
      "terminated",
    ];

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status filter",
      });
    }

    if (
      department &&
      (typeof department !== "string" || department.length > 100)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid department filter",
      });
    }

    const values = [req.user.tenantId];
    const conditions = ["tenant_id = $1"];

    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }

    if (department) {
      values.push(department);
      conditions.push(`department = $${values.length}`);
    }

    const result = await pool.query(
      `SELECT *
       FROM staff
       WHERE ${conditions.join(" AND ")}
       ORDER BY first_name, last_name, id`,
      values
    );

    return res.json({
      success: true,
      count: result.rowCount,
      staff: result.rows,
    });
  } catch (error) {
    console.error("List staff error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch staff members",
    });
  }
});

// GET /api/staff/:id - Get one staff member
router.get("/:id", async (req, res) => {
  try {
    const staffId = Number(req.params.id);

    if (!Number.isSafeInteger(staffId) || staffId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid staff ID",
      });
    }

    const result = await pool.query(
      `SELECT *
       FROM staff
       WHERE id = $1 AND tenant_id = $2`,
      [staffId, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    return res.json({
      success: true,
      staff: result.rows[0],
    });
  } catch (error) {
    console.error("Get staff error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch staff member",
    });
  }
});

const editableStaffFields = {
  employeeNumber: "employee_number",
  firstName: "first_name",
  lastName: "last_name",
  email: "email",
  phone: "phone",
  department: "department",
  designation: "designation",
  employmentType: "employment_type",
  joiningDate: "joining_date",
  salaryPaise: "salary_paise",
  address: "address",
};

// PATCH /api/staff/:id - Update employee details
router.patch("/:id", async (req, res) => {
  try {
    const staffId = Number(req.params.id);

    if (!Number.isSafeInteger(staffId) || staffId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid staff ID",
      });
    }

    const entries = Object.entries(req.body || {}).filter(
      ([key, value]) =>
        Object.hasOwn(editableStaffFields, key) && value !== undefined
    );

    if (entries.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one valid field to update",
      });
    }

    const data = Object.fromEntries(entries);

    if (
      "employeeNumber" in data &&
      (typeof data.employeeNumber !== "string" ||
        !data.employeeNumber.trim() ||
        data.employeeNumber.trim().length > 50)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid employee number",
      });
    }

    if (
      "firstName" in data &&
      (typeof data.firstName !== "string" ||
        !data.firstName.trim() ||
        data.firstName.trim().length > 100)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid first name",
      });
    }

    if (
      "salaryPaise" in data &&
      (!Number.isSafeInteger(data.salaryPaise) ||
        data.salaryPaise < 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "salaryPaise must be a non-negative integer",
      });
    }

    if (
      "employmentType" in data &&
      !["full_time", "part_time", "contract", "temporary"].includes(
        data.employmentType
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid employment type",
      });
    }

    if ("joiningDate" in data) {
      const date = data.joiningDate;
      const parsed = typeof date === "string"
        ? new Date(`${date}T00:00:00Z`)
        : new Date(NaN);

      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
      ) {
        return res.status(400).json({
          success: false,
          message: "joiningDate must be a valid YYYY-MM-DD date",
        });
      }
    }

    if ("email" in data && data.email !== null) {
      if (
        typeof data.email !== "string" ||
        data.email.length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid email address",
        });
      }

      data.email = data.email.trim().toLowerCase();
    }

    for (const key of [
      "lastName",
      "phone",
      "department",
      "designation",
      "address",
    ]) {
      if (key in data && data[key] !== null) {
        if (typeof data[key] !== "string") {
          return res.status(400).json({
            success: false,
            message: `${key} must be a string or null`,
          });
        }

        data[key] = data[key].trim() || null;
      }
    }

    if ("firstName" in data) data.firstName = data.firstName.trim();
    if ("employeeNumber" in data) {
      data.employeeNumber = data.employeeNumber.trim();
    }

    const values = [];
    const setClauses = entries.map(([key]) => {
      values.push(data[key]);
      return `${editableStaffFields[key]} = $${values.length}`;
    });

    values.push(staffId, req.user.tenantId);

    const result = await pool.query(
      `UPDATE staff
       SET ${setClauses.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length - 1}
         AND tenant_id = $${values.length}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    return res.json({
      success: true,
      message: "Staff member updated successfully",
      staff: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Employee number already exists for this school",
      });
    }

    console.error("Update staff error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update staff member",
    });
  }
});

// PATCH /api/staff/:id/status - Change employment status
router.patch("/:id/status", async (req, res) => {
  try {
    const staffId = Number(req.params.id);
    const { status } = req.body || {};

    if (!Number.isSafeInteger(staffId) || staffId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid staff ID",
      });
    }

    if (!["active", "inactive", "on_leave", "terminated"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be active, inactive, on_leave, or terminated",
      });
    }

    const result = await pool.query(
      `UPDATE staff
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [status, staffId, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    return res.json({
      success: true,
      message: "Staff status updated successfully",
      staff: result.rows[0],
    });
  } catch (error) {
    console.error("Update staff status error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update staff status",
    });
  }
});

module.exports = router;
