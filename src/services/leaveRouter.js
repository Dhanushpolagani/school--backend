
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const router = express.Router();

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
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
}

router.use(authenticateToken);

const leaveTypes = ["casual", "sick", "earned", "unpaid", "other"];

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

// POST /api/leave - Submit a leave request
router.post("/", async (req, res) => {
  try {
    const { staffId, leaveType, startDate, endDate, reason } = req.body || {};

    const parsedStaffId = Number(staffId);

    if (!Number.isSafeInteger(parsedStaffId) || parsedStaffId <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid staffId is required",
      });
    }

    if (!leaveTypes.includes(leaveType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid leaveType",
      });
    }

    if (
      !validDate(startDate) ||
      !validDate(endDate) ||
      endDate < startDate
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid startDate and endDate are required; endDate must not precede startDate",
      });
    }

    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.trim().length > 2000
    ) {
      return res.status(400).json({
        success: false,
        message: "Reason is required and must not exceed 2000 characters",
      });
    }

    const staff = await pool.query(
      `SELECT id, status
       FROM staff
       WHERE id = $1 AND tenant_id = $2`,
      [parsedStaffId, req.user.tenantId]
    );

    if (staff.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    if (staff.rows[0].status === "terminated") {
      return res.status(409).json({
        success: false,
        message: "Terminated staff cannot submit leave requests",
      });
    }

    // Prevent overlapping pending or approved leave requests.
    const overlap = await pool.query(
      `SELECT id
       FROM staff_leave_requests
       WHERE tenant_id = $1
         AND staff_id = $2
         AND status IN ('pending', 'approved')
         AND start_date <= $4::date
         AND end_date >= $3::date
       LIMIT 1`,
      [req.user.tenantId, parsedStaffId, startDate, endDate]
    );

    if (overlap.rowCount > 0) {
      return res.status(409).json({
        success: false,
        message: "This request overlaps an existing pending or approved leave request",
      });
    }

    const result = await pool.query(
      `INSERT INTO staff_leave_requests (
         tenant_id, staff_id, leave_type,
         start_date, end_date, reason
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.user.tenantId,
        parsedStaffId,
        leaveType,
        startDate,
        endDate,
        reason.trim(),
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Leave request submitted successfully",
      leaveRequest: result.rows[0],
    });
  } catch (error) {
    console.error("Create leave request error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to submit leave request",
    });
  }
});

// GET /api/leave - List leave requests
router.get("/", async (req, res) => {
  try {
    const { staffId, status } = req.query;
    const values = [req.user.tenantId];
    const conditions = ["lr.tenant_id = $1"];

    if (staffId !== undefined) {
      const id = Number(staffId);

      if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid staffId filter",
        });
      }

      values.push(id);
      conditions.push(`lr.staff_id = $${values.length}`);
    }

    if (status !== undefined) {
      if (!["pending", "approved", "rejected", "cancelled"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status filter",
        });
      }

      values.push(status);
      conditions.push(`lr.status = $${values.length}`);
    }

    const result = await pool.query(
      `SELECT
         lr.*,
         s.employee_number,
         s.first_name,
         s.last_name,
         s.department,
         s.designation
       FROM staff_leave_requests lr
       JOIN staff s
         ON s.id = lr.staff_id
        AND s.tenant_id = lr.tenant_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY lr.created_at DESC, lr.id DESC`,
      values
    );

    return res.json({
      success: true,
      count: result.rowCount,
      leaveRequests: result.rows,
    });
  } catch (error) {
    console.error("List leave requests error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch leave requests",
    });
  }
});
// GET /api/leave/balances?staffId=1&year=2026
router.get("/balances", async (req, res) => {
  try {
    const year = req.query.year === undefined
      ? new Date().getFullYear()
      : Number(req.query.year);

    if (!Number.isInteger(year) || year < 2000 || year > 2200) {
      return res.status(400).json({
        success: false,
        message: "Invalid year",
      });
    }

    const values = [req.user.tenantId, year];
    let staffFilter = "";

    if (req.query.staffId !== undefined) {
      if (!isValidId(req.query.staffId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid staffId",
        });
      }

      values.push(Number(req.query.staffId));
      staffFilter = `AND b.staff_id = $${values.length}`;
    }

    const result = await pool.query(
      `SELECT b.*,
              s.employee_number,
              s.first_name,
              s.last_name,
              b.allocated_days - b.used_days AS remaining_days
       FROM staff_leave_balances b
       JOIN staff s
         ON s.id = b.staff_id
        AND s.tenant_id = b.tenant_id
       WHERE b.tenant_id = $1
         AND b.leave_year = $2
         ${staffFilter}
       ORDER BY s.first_name, s.last_name, b.leave_type`,
      values
    );

    return res.json({
      success: true,
      year,
      count: result.rowCount,
      balances: result.rows,
    });
  } catch (error) {
    console.error("Get leave balances error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch leave balances",
    });
  }
});
// GET /api/leave/:id - Get one request

/*
 * STAFF & LEAVE REPORTS
 * Insert before: GET /api/leave/:id
 */

// GET /api/leave/pending-approvals
router.get("/pending-approvals", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can view pending approvals",
    });
  }

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM staff_leave_requests
       WHERE tenant_id = $1 AND status = 'pending'`,
      [req.user.tenantId]
    );

    const requestsResult = await pool.query(
      `SELECT
         lr.id,
         lr.staff_id,
         lr.leave_type,
         lr.start_date,
         lr.end_date,
         lr.reason,
         lr.created_at,
         s.employee_number,
         s.first_name,
         s.last_name,
         s.department
       FROM staff_leave_requests lr
       JOIN staff s
         ON s.id = lr.staff_id
        AND s.tenant_id = lr.tenant_id
       WHERE lr.tenant_id = $1
         AND lr.status = 'pending'
       ORDER BY lr.created_at ASC, lr.id ASC
       LIMIT 50`,
      [req.user.tenantId]
    );

    return res.json({
      success: true,
      count: countResult.rows[0].count,
      requests: requestsResult.rows,
      limit: 50,
    });
  } catch (error) {
    console.error("Pending approvals report error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch pending approvals",
    });
  }
});

// GET /api/leave/reports/staff/:staffId/history?year=2026
router.get("/reports/staff/:staffId/history", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can view leave reports",
    });
  }

  const staffId = Number(req.params.staffId);

  if (!isValidId(staffId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid staff ID",
    });
  }

  try {
    const staffResult = await pool.query(
      `SELECT id, employee_number, first_name, last_name,
              department, designation
       FROM staff
       WHERE id = $1 AND tenant_id = $2`,
      [staffId, req.user.tenantId]
    );

    if (staffResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    const values = [req.user.tenantId, staffId];
    let yearFilter = "";

    if (req.query.year !== undefined) {
      const year = Number(req.query.year);

      if (!Number.isInteger(year) || year < 2000 || year > 2200) {
        return res.status(400).json({
          success: false,
          message: "Invalid year",
        });
      }

      values.push(`${year}-01-01`, `${year}-12-31`);
      yearFilter =
        `AND lr.start_date <= $4::date AND lr.end_date >= $3::date`;
    }

    const result = await pool.query(
      `SELECT lr.*
       FROM staff_leave_requests lr
       WHERE lr.tenant_id = $1
         AND lr.staff_id = $2
         ${yearFilter}
       ORDER BY lr.start_date DESC, lr.id DESC`,
      values
    );

    return res.json({
      success: true,
      staff: staffResult.rows[0],
      year: req.query.year === undefined
        ? null
        : Number(req.query.year),
      count: result.rowCount,
      leaveHistory: result.rows,
    });
  } catch (error) {
    console.error("Staff leave history report error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch staff leave history",
    });
  }
});

// GET /api/leave/reports/monthly?month=2026-10
router.get("/reports/monthly", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can view leave reports",
    });
  }

  const month = req.query.month;

  if (
    typeof month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide month in YYYY-MM format, for example 2026-10",
    });
  }

  const [yearPart, monthPart] = month.split("-");
  const year = Number(yearPart);
  const monthNumber = Number(monthPart);

  if (year < 2000 || year > 2200) {
    return res.status(400).json({
      success: false,
      message: "Invalid year",
    });
  }

  const monthStart = `${month}-01`;
  const monthEnd = new Date(
    Date.UTC(year, monthNumber, 0)
  ).toISOString().slice(0, 10);

  try {
    const params = [req.user.tenantId, monthStart, monthEnd];

    const summaryResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_requests,
         COUNT(*) FILTER (
           WHERE status = 'pending'
         )::int AS pending_requests,
         COUNT(*) FILTER (
           WHERE status = 'approved'
         )::int AS approved_requests,
         COUNT(*) FILTER (
           WHERE status = 'rejected'
         )::int AS rejected_requests,
         COUNT(*) FILTER (
           WHERE status = 'cancelled'
         )::int AS cancelled_requests,
         COALESCE(
           SUM(
             CASE WHEN status = 'approved'
               THEN LEAST(end_date, $3::date)
                  - GREATEST(start_date, $2::date) + 1
               ELSE 0
             END
           ), 0
         )::int AS approved_calendar_days
       FROM staff_leave_requests
       WHERE tenant_id = $1
         AND start_date <= $3::date
         AND end_date >= $2::date`,
      params
    );

    const typeResult = await pool.query(
      `SELECT
         leave_type,
         COUNT(*)::int AS total_requests,
         COUNT(*) FILTER (
           WHERE status = 'pending'
         )::int AS pending_requests,
         COUNT(*) FILTER (
           WHERE status = 'approved'
         )::int AS approved_requests,
         COUNT(*) FILTER (
           WHERE status = 'rejected'
         )::int AS rejected_requests,
         COUNT(*) FILTER (
           WHERE status = 'cancelled'
         )::int AS cancelled_requests
       FROM staff_leave_requests
       WHERE tenant_id = $1
         AND start_date <= $3::date
         AND end_date >= $2::date
       GROUP BY leave_type
       ORDER BY leave_type`,
      params
    );

    return res.json({
      success: true,
      month,
      summary: summaryResult.rows[0],
      byLeaveType: typeResult.rows,
    });
  } catch (error) {
    console.error("Monthly leave report error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate monthly leave report",
    });
  }
});

// GET /api/leave/reports/annual?year=2026
router.get("/reports/annual", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can view leave reports",
    });
  }

  const year = req.query.year === undefined
    ? new Date().getFullYear()
    : Number(req.query.year);

  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    return res.status(400).json({
      success: false,
      message: "Invalid year",
    });
  }

  try {
    const balancesResult = await pool.query(
      `SELECT
         s.id AS staff_id,
         s.employee_number,
         s.first_name,
         s.last_name,
         s.department,
         b.leave_type,
         b.allocated_days,
         b.used_days,
         b.allocated_days - b.used_days AS remaining_days,
         CASE
           WHEN b.allocated_days = 0 THEN 0
           ELSE ROUND(
             (b.used_days / b.allocated_days) * 100, 2
           )
         END AS utilization_percent
       FROM staff_leave_balances b
       JOIN staff s
         ON s.id = b.staff_id
        AND s.tenant_id = b.tenant_id
       WHERE b.tenant_id = $1
         AND b.leave_year = $2
       ORDER BY s.first_name, s.last_name, b.leave_type`,
      [req.user.tenantId, year]
    );

    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const requestsResult = await pool.query(
      `SELECT
         status,
         leave_type,
         COUNT(*)::int AS request_count,
         COALESCE(
           SUM(
             CASE WHEN status = 'approved'
               THEN LEAST(end_date, $3::date)
                  - GREATEST(start_date, $2::date) + 1
               ELSE 0
             END
           ), 0
         )::int AS approved_calendar_days
       FROM staff_leave_requests
       WHERE tenant_id = $1
         AND start_date <= $3::date
         AND end_date >= $2::date
       GROUP BY status, leave_type
       ORDER BY leave_type, status`,
      [req.user.tenantId, yearStart, yearEnd]
    );

    return res.json({
      success: true,
      year,
      balances: balancesResult.rows,
      requestSummary: requestsResult.rows,
    });
  } catch (error) {
    console.error("Annual leave report error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate annual leave report",
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const leaveId = Number(req.params.id);

    if (!Number.isSafeInteger(leaveId) || leaveId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid leave request ID",
      });
    }

    const result = await pool.query(
      `SELECT
         lr.*,
         s.employee_number,
         s.first_name,
         s.last_name,
         s.department,
         s.designation
       FROM staff_leave_requests lr
       JOIN staff s
         ON s.id = lr.staff_id
        AND s.tenant_id = lr.tenant_id
       WHERE lr.id = $1 AND lr.tenant_id = $2`,
      [leaveId, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Leave request not found",
      });
    }

    return res.json({
      success: true,
      leaveRequest: result.rows[0],
    });
  } catch (error) {
    console.error("Get leave request error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch leave request",
    });
  }
});

// PATCH /api/leave/:id/cancel - Cancel a pending request
router.patch("/:id/cancel", async (req, res) => {
  try {
    const leaveId = Number(req.params.id);

    if (!Number.isSafeInteger(leaveId) || leaveId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid leave request ID",
      });
    }

    const result = await pool.query(
      `UPDATE staff_leave_requests
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND status = 'pending'
       RETURNING *`,
      [leaveId, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Pending leave request not found",
      });
    }

    return res.json({
      success: true,
      message: "Leave request cancelled successfully",
      leaveRequest: result.rows[0],
    });
  } catch (error) {
    console.error("Cancel leave request error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to cancel leave request",
    });
  }
});

function isSchoolAdmin(req) {
  return Array.isArray(req.user.roles) &&
    req.user.roles.includes("school_admin");
}

function isValidId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0;
}

function dateText(value) {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function calendarDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000) + 1;
}



// PUT /api/leave/balances
router.put("/balances", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can configure allowances",
    });
  }

  const { staffId, leaveYear, leaveType, allocatedDays } = req.body || {};
  const year = Number(leaveYear);
  const allocation = Number(allocatedDays);

  if (!isValidId(staffId)) {
    return res.status(400).json({
      success: false,
      message: "A valid staffId is required",
    });
  }

  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    return res.status(400).json({
      success: false,
      message: "A valid leaveYear is required",
    });
  }

  if (!["casual", "sick", "earned"].includes(leaveType)) {
    return res.status(400).json({
      success: false,
      message: "leaveType must be casual, sick, or earned",
    });
  }

  if (
    allocatedDays === undefined ||
    allocatedDays === null ||
    typeof allocatedDays === "boolean" ||
    (typeof allocatedDays === "string" && !allocatedDays.trim()) ||
    !Number.isFinite(allocation) ||
    allocation < 0 ||
    allocation > 9999.99 ||
    Number(allocation.toFixed(2)) !== allocation
  ) {
    return res.status(400).json({
      success: false,
      message: "allocatedDays must be between 0 and 9999.99 with at most 2 decimal places",
    });
  }

  try {
    const staff = await pool.query(
      `SELECT id FROM staff
       WHERE id = $1 AND tenant_id = $2`,
      [Number(staffId), req.user.tenantId]
    );

    if (staff.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Staff member not found",
      });
    }

    const result = await pool.query(
      `INSERT INTO staff_leave_balances (
         tenant_id, staff_id, leave_year,
         leave_type, allocated_days
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, staff_id, leave_year, leave_type)
       DO UPDATE SET
         allocated_days = EXCLUDED.allocated_days,
         updated_at = NOW()
       WHERE staff_leave_balances.used_days <= EXCLUDED.allocated_days
       RETURNING *,
         allocated_days - used_days AS remaining_days`,
      [
        req.user.tenantId,
        Number(staffId),
        year,
        leaveType,
        allocation,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        success: false,
        message: "Allowance cannot be lower than leave already used",
      });
    }

    return res.json({
      success: true,
      message: "Leave allowance saved successfully",
      balance: result.rows[0],
    });
  } catch (error) {
    console.error("Save leave balance error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save leave allowance",
    });
  }
});

// PATCH /api/leave/:id/approve
router.patch("/:id/approve", async (req, res) => {
  console.log("APPROVE DEBUG:", {
  method: req.method,
  url: req.originalUrl,
  id: req.params.id
});
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can approve leave",
    });
  }

  const leaveId = Number(req.params.id);

  if (!Number.isSafeInteger(leaveId) || leaveId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid leave request ID",
    });
  }

  const reviewComment = req.body?.reviewComment;

  if (
    reviewComment !== undefined &&
    (typeof reviewComment !== "string" || reviewComment.length > 2000)
  ) {
    return res.status(400).json({
      success: false,
      message: "reviewComment must be a string of at most 2000 characters",
    });
  }

  const client = await pool.connect();
  let inTransaction = false;

  try {
    await client.query("BEGIN");
    inTransaction = true;

    const requestResult = await client.query(
      `SELECT *
       FROM staff_leave_requests
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [leaveId, req.user.tenantId]
    );

    if (requestResult.rowCount === 0) {
      await client.query("ROLLBACK");
      inTransaction = false;

      return res.status(404).json({
        success: false,
        message: "Leave request not found",
      });
    }

    const leave = requestResult.rows[0];

    if (leave.status !== "pending") {
      await client.query("ROLLBACK");
      inTransaction = false;

      return res.status(409).json({
        success: false,
        message: "Only pending leave requests can be approved",
      });
    }

    const startDate = dateText(leave.start_date);
    const endDate = dateText(leave.end_date);
    const paidTypes = ["casual", "sick", "earned"];

    // Only configured paid leave types consume an allowance.
    // Leave is counted in calendar days, including weekends.
    if (paidTypes.includes(leave.leave_type)) {
      const firstYear = Number(startDate.slice(0, 4));
      const lastYear = Number(endDate.slice(0, 4));

      for (let year = firstYear; year <= lastYear; year++) {
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;

        const segmentStart = startDate > yearStart
          ? startDate
          : yearStart;

        const segmentEnd = endDate < yearEnd
          ? endDate
          : yearEnd;

        const days = calendarDays(segmentStart, segmentEnd);

        const balanceResult = await client.query(
          `SELECT *
           FROM staff_leave_balances
           WHERE tenant_id = $1
             AND staff_id = $2
             AND leave_year = $3
             AND leave_type = $4
           FOR UPDATE`,
          [
            req.user.tenantId,
            leave.staff_id,
            year,
            leave.leave_type,
          ]
        );

        if (balanceResult.rowCount === 0) {
          await client.query("ROLLBACK");
          inTransaction = false;

          return res.status(409).json({
            success: false,
            message: `No ${leave.leave_type} allowance is configured for ${year}`,
          });
        }

        const balance = balanceResult.rows[0];
        const remaining =
          Number(balance.allocated_days) - Number(balance.used_days);

        if (remaining < days) {
          await client.query("ROLLBACK");
          inTransaction = false;

          return res.status(409).json({
            success: false,
            message: `Insufficient ${leave.leave_type} leave balance for ${year}`,
            remainingDays: remaining,
            requestedDays: days,
          });
        }

        const updatedBalance = await client.query(
          `UPDATE staff_leave_balances
           SET used_days = used_days + $1,
               updated_at = NOW()
           WHERE id = $2
             AND used_days + $1 <= allocated_days
           RETURNING id`,
          [days, balance.id]
        );

        if (updatedBalance.rowCount === 0) {
          throw new Error("Leave balance changed during approval");
        }
      }
    }

    const approved = await client.query(
      `UPDATE staff_leave_requests
       SET status = 'approved',
           reviewed_by = $1,
           reviewed_at = NOW(),
           review_comment = $2,
           updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4
       RETURNING *`,
      [
        req.user.id,
        reviewComment?.trim() || null,
        leaveId,
        req.user.tenantId,
      ]
    );

    await client.query("COMMIT");
    inTransaction = false;

    return res.json({
      success: true,
      message: "Leave request approved successfully",
      leaveRequest: approved.rows[0],
    });
  } catch (error) {
    if (inTransaction) {
      await client.query("ROLLBACK");
    }

    console.error("Approve leave error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to approve leave request",
    });
  } finally {
    client.release();
  }
});

// PATCH /api/leave/:id/reject
router.patch("/:id/reject", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can reject leave",
    });
  }

  const leaveId = Number(req.params.id);
  const comment = req.body?.reviewComment;

  if (!Number.isSafeInteger(leaveId) || leaveId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid leave request ID",
    });
  }

  if (
    comment !== undefined &&
    (typeof comment !== "string" || comment.length > 2000)
  ) {
    return res.status(400).json({
      success: false,
      message: "reviewComment must be a string of at most 2000 characters",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE staff_leave_requests
       SET status = 'rejected',
           reviewed_by = $1,
           reviewed_at = NOW(),
           review_comment = $2,
           updated_at = NOW()
       WHERE id = $3
         AND tenant_id = $4
         AND status = 'pending'
       RETURNING *`,
      [
        req.user.id,
        comment?.trim() || null,
        leaveId,
        req.user.tenantId,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        success: false,
        message: "Pending leave request not found or already processed",
      });
    }

    return res.json({
      success: true,
      message: "Leave request rejected successfully",
      leaveRequest: result.rows[0],
    });
  } catch (error) {
    console.error("Reject leave error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to reject leave request",
    });
  }
});

module.exports = router;
