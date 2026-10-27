
const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

const allowedStatuses = [
  "present",
  "absent",
  "on_leave",
  "outing",
  "late"
];

const allowedSessions = ["morning", "evening", "night"];

const canMarkAttendance = (req) =>
  Array.isArray(req.user?.roles) &&
  req.user.roles.some((role) =>
    ["school_admin", "teacher"].includes(role)
  );

const validId = (value) => /^[1-9]\d*$/.test(String(value ?? ""));

const validDate = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
};

const validRemarks = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.length <= 2000);

const validAttendance = (status, remarks) =>
  allowedStatuses.includes(status) && validRemarks(remarks);

const databaseError = (res, error, action) => {
  if (error.code === "23503") {
    return res.status(400).json({
      success: false,
      message: "A referenced record does not exist."
    });
  }

  console.error(`${action}:`, error);

  return res.status(500).json({
    success: false,
    message: `Unable to ${action}.`
  });
};

// =====================================================
// 1. MARK ATTENDANCE FOR ONE STUDENT
// POST /api/hostel-attendance
// =====================================================
router.post("/", async (req, res) => {
  if (!canMarkAttendance(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators and teachers can mark attendance."
    });
  }

  const {
    allocationId,
    attendanceDate,
    session = "night",
    status,
    remarks = null
  } = req.body;

  if (
    !validId(allocationId) ||
    !validDate(attendanceDate) ||
    !allowedSessions.includes(session) ||
    !validAttendance(status, remarks)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid allocation ID, date, session, status, or remarks."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const allocation = await client.query(
      `SELECT id
       FROM hostel_allocations
       WHERE tenant_id = $1
         AND id = $2
         AND status <> 'cancelled'
         AND allocated_on <= $3::date
         AND (vacated_on IS NULL OR vacated_on >= $3::date)
       FOR UPDATE`,
      [req.user.tenantId, allocationId, attendanceDate]
    );

    if (allocation.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "No valid hostel allocation was found for this student on that date."
      });
    }

    const result = await client.query(
      `INSERT INTO hostel_attendance (
         tenant_id,
         allocation_id,
         attendance_date,
         session,
         status,
         remarks,
         marked_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (
         tenant_id,
         allocation_id,
         attendance_date,
         session
       )
       DO UPDATE SET
         status = EXCLUDED.status,
         remarks = EXCLUDED.remarks,
         marked_by = EXCLUDED.marked_by,
         updated_at = NOW()
       RETURNING *`,
      [
        req.user.tenantId,
        allocationId,
        attendanceDate,
        session,
        status,
        remarks,
        req.user.sub
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Hostel attendance saved successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return databaseError(res, error, "Save hostel attendance");
  } finally {
    client.release();
  }
});

// =====================================================
// 2. BULK MARK ATTENDANCE
// POST /api/hostel-attendance/bulk
//
// records: [{ allocationId, status, remarks }]
// Maximum 500 records per request.
// =====================================================
router.post("/bulk", async (req, res) => {
  if (!canMarkAttendance(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators and teachers can mark attendance."
    });
  }

  const {
    attendanceDate,
    session = "night",
    records
  } = req.body;

  if (
    !validDate(attendanceDate) ||
    !allowedSessions.includes(session) ||
    !Array.isArray(records) ||
    records.length === 0 ||
    records.length > 500
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid date, session, and between 1 and 500 attendance records."
    });
  }

  const seen = new Set();

  for (const record of records) {
    if (
      !record ||
      !validId(record.allocationId) ||
      !validAttendance(record.status, record.remarks)
    ) {
      return res.status(400).json({
        success: false,
        message: "Each record needs a valid allocationId, status, and optional remarks."
      });
    }

    const id = String(record.allocationId);

    if (seen.has(id)) {
      return res.status(400).json({
        success: false,
        message: `Duplicate allocationId: ${id}.`
      });
    }

    seen.add(id);
  }

  const allocationIds = records.map((record) =>
    String(record.allocationId)
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const allocationResult = await client.query(
      `SELECT id
       FROM hostel_allocations
       WHERE tenant_id = $1
         AND id = ANY($2::bigint[])
         AND status <> 'cancelled'
         AND allocated_on <= $3::date
         AND (vacated_on IS NULL OR vacated_on >= $3::date)
       FOR UPDATE`,
      [req.user.tenantId, allocationIds, attendanceDate]
    );

    if (allocationResult.rows.length !== allocationIds.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "At least one allocation is invalid, belongs to another school, or was not valid on the attendance date. No records were saved."
      });
    }

    const saved = [];

    for (const record of records) {
      const result = await client.query(
        `INSERT INTO hostel_attendance (
           tenant_id,
           allocation_id,
           attendance_date,
           session,
           status,
           remarks,
           marked_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (
           tenant_id,
           allocation_id,
           attendance_date,
           session
         )
         DO UPDATE SET
           status = EXCLUDED.status,
           remarks = EXCLUDED.remarks,
           marked_by = EXCLUDED.marked_by,
           updated_at = NOW()
         RETURNING *`,
        [
          req.user.tenantId,
          record.allocationId,
          attendanceDate,
          session,
          record.status,
          record.remarks ?? null,
          req.user.sub
        ]
      );

      saved.push(result.rows[0]);
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Bulk hostel attendance saved successfully.",
      count: saved.length,
      data: saved
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return databaseError(res, error, "Save bulk hostel attendance");
  } finally {
    client.release();
  }
});

// =====================================================
// 3. VIEW ATTENDANCE RECORDS
// GET /api/hostel-attendance
//
// Optional filters:
// attendanceDate, session, status, hostelId, roomId, studentId
// =====================================================
router.get("/", async (req, res) => {
  const {
    attendanceDate,
    session,
    status,
    hostelId,
    roomId,
    studentId
  } = req.query;

  if (
    (attendanceDate !== undefined && !validDate(attendanceDate)) ||
    (session !== undefined && !allowedSessions.includes(session)) ||
    (status !== undefined && !allowedStatuses.includes(status)) ||
    (hostelId !== undefined && !validId(hostelId)) ||
    (roomId !== undefined && !validId(roomId)) ||
    (studentId !== undefined && !validId(studentId))
  ) {
    return res.status(400).json({
      success: false,
      message: "One or more attendance filters are invalid."
    });
  }

  const values = [req.user.tenantId];
  const conditions = ["ha.tenant_id = $1"];

  const filters = [
    ["attendanceDate", "ha.attendance_date"],
    ["session", "ha.session"],
    ["status", "ha.status"],
    ["hostelId", "a.hostel_id"],
    ["roomId", "a.room_id"],
    ["studentId", "a.student_id"]
  ];

  for (const [key, column] of filters) {
    if (req.query[key] !== undefined) {
      values.push(req.query[key]);
      conditions.push(`${column} = $${values.length}`);
    }
  }

  try {
    const result = await pool.query(
      `SELECT
         ha.id AS attendance_id,
         ha.attendance_date,
         ha.session,
         ha.status,
         ha.remarks,
         ha.marked_by,
         ha.created_at,
         s.id AS student_id,
         s.admission_number,
         s.first_name,
         s.last_name,
         s.class_name,
         s.section,
         a.id AS allocation_id,
         h.id AS hostel_id,
         h.name AS hostel_name,
         r.id AS room_id,
         r.room_number,
         a.bed_number
       FROM hostel_attendance ha
       JOIN hostel_allocations a
         ON a.id = ha.allocation_id
        AND a.tenant_id = ha.tenant_id
       JOIN students s
         ON s.id = a.student_id
        AND s.tenant_id = a.tenant_id
       JOIN hostels h
         ON h.id = a.hostel_id
        AND h.tenant_id = a.tenant_id
       JOIN hostel_rooms r
         ON r.id = a.room_id
        AND r.tenant_id = a.tenant_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY
         ha.attendance_date DESC,
         ha.session,
         h.name,
         r.room_number,
         s.first_name
       LIMIT 500`,
      values
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    return databaseError(res, error, "Retrieve hostel attendance");
  }
});

// =====================================================
// 4. DAILY ATTENDANCE SUMMARY
// GET /api/hostel-attendance/summary?attendanceDate=YYYY-MM-DD
// Optional filters: session, hostelId
// =====================================================
router.get("/summary", async (req, res) => {
  const { attendanceDate, session, hostelId } = req.query;

  if (
    !validDate(attendanceDate) ||
    (session !== undefined && !allowedSessions.includes(session)) ||
    (hostelId !== undefined && !validId(hostelId))
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid attendanceDate is required. Session and hostelId are optional."
    });
  }

  const values = [req.user.tenantId, attendanceDate];
  const conditions = [
    "ha.tenant_id = $1",
    "ha.attendance_date = $2::date"
  ];

  if (session !== undefined) {
    values.push(session);
    conditions.push(`ha.session = $${values.length}`);
  }

  if (hostelId !== undefined) {
    values.push(hostelId);
    conditions.push(`a.hostel_id = $${values.length}`);
  }

  try {
    const result = await pool.query(
      `SELECT
         COUNT(*)::int AS total_marked,
         COUNT(*) FILTER (WHERE ha.status = 'present')::int AS present,
         COUNT(*) FILTER (WHERE ha.status = 'absent')::int AS absent,
         COUNT(*) FILTER (WHERE ha.status = 'on_leave')::int AS on_leave,
         COUNT(*) FILTER (WHERE ha.status = 'outing')::int AS outing,
         COUNT(*) FILTER (WHERE ha.status = 'late')::int AS late
       FROM hostel_attendance ha
       JOIN hostel_allocations a
         ON a.id = ha.allocation_id
        AND a.tenant_id = ha.tenant_id
       WHERE ${conditions.join(" AND ")}`,
      values
    );

    return res.json({
      success: true,
      attendanceDate,
      session: session || "all",
      data: result.rows[0]
    });
  } catch (error) {
    return databaseError(res, error, "Retrieve hostel attendance summary");
  }
});

// =====================================================
// 5. CORRECT AN ATTENDANCE RECORD
// PATCH /api/hostel-attendance/:attendanceId
// =====================================================
router.patch("/:attendanceId", async (req, res) => {
  if (!canMarkAttendance(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators and teachers can update attendance."
    });
  }

  const { attendanceId } = req.params;
  const { status, remarks } = req.body;

  if (
    !validId(attendanceId) ||
    (status === undefined && remarks === undefined) ||
    (status !== undefined && !allowedStatuses.includes(status)) ||
    (remarks !== undefined && !validRemarks(remarks))
  ) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid attendance ID and at least one valid field to update."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id
       FROM hostel_attendance
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [req.user.tenantId, attendanceId]
    );

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Hostel attendance record not found."
      });
    }

    const result = await client.query(
      `UPDATE hostel_attendance
       SET status = COALESCE($3, status),
           remarks = CASE
             WHEN $4::boolean THEN $5::text
             ELSE remarks
           END,
           marked_by = $6,
           updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        req.user.tenantId,
        attendanceId,
        status ?? null,
        remarks !== undefined,
        remarks ?? null,
        req.user.sub
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Hostel attendance updated successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return databaseError(res, error, "Update hostel attendance");
  } finally {
    client.release();
  }
});

module.exports = router;
