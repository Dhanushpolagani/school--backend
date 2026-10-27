
const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

const ALLOWED_STATUSES = [
  "present",
  "absent",
  "late",
  "excused",
];

function isPositiveInteger(value) {
  return /^[1-9]\d*$/.test(String(value));
}

function isValidDate(value) {
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
}

// POST /api/attendance/mark
// Create or update attendance for one student.
router.post("/mark", async (req, res, next) => {
  const {
    studentId,
    attendanceDate,
    status,
    remarks = null,
  } = req.body;

  if (!isPositiveInteger(studentId)) {
    return res.status(400).json({
      success: false,
      message: "A valid studentId is required",
    });
  }

  if (!isValidDate(attendanceDate)) {
    return res.status(400).json({
      success: false,
      message: "attendanceDate must use YYYY-MM-DD format",
    });
  }

  if (
    typeof status !== "string" ||
    !ALLOWED_STATUSES.includes(status.toLowerCase())
  ) {
    return res.status(400).json({
      success: false,
      message: "Status must be present, absent, late, or excused",
    });
  }

  if (
    remarks !== null &&
    (typeof remarks !== "string" || remarks.length > 500)
  ) {
    return res.status(400).json({
      success: false,
      message: "Remarks must be text of at most 500 characters",
    });
  }

  try {
    const tenantId = req.user.tenantId;
    const normalizedStatus = status.toLowerCase();

    // Verify that the student belongs to this school.
    const studentResult = await pool.query(
      `SELECT id
       FROM students
       WHERE id = $1
         AND tenant_id = $2
         AND status = 'active'`,
      [Number(studentId), tenantId]
    );

    if (studentResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Active student not found in your school",
      });
    }

    // Update existing attendance or insert a new record.
    const result = await pool.query(
      `INSERT INTO student_attendance (
         tenant_id,
         student_id,
         attendance_date,
         status,
         remarks,
         marked_by
       )
       VALUES ($1, $2, $3::date, $4, $5, $6)
       ON CONFLICT (tenant_id, student_id, attendance_date)
       DO UPDATE SET
         status = EXCLUDED.status,
         remarks = EXCLUDED.remarks,
         marked_by = EXCLUDED.marked_by,
         updated_at = NOW()
       RETURNING id, student_id, attendance_date,
                 status, remarks, marked_by,
                 created_at, updated_at`,
      [
        tenantId,
        Number(studentId),
        attendanceDate,
        normalizedStatus,
        remarks,
        Number(req.user.id),
      ]
    );

    return res.status(200).json({
      success: true,
      message: "Attendance saved successfully",
      attendance: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/attendance?date=2026-10-12
// Optional filters: classId and sectionId.
router.get("/", async (req, res, next) => {
  const { date, classId, sectionId } = req.query;

  if (!isValidDate(date)) {
    return res.status(400).json({
      success: false,
      message: "Provide a valid date using ?date=YYYY-MM-DD",
    });
  }

  if (
    classId !== undefined &&
    !isPositiveInteger(classId)
  ) {
    return res.status(400).json({
      success: false,
      message: "classId must be a positive integer",
    });
  }

  if (
    sectionId !== undefined &&
    !isPositiveInteger(sectionId)
  ) {
    return res.status(400).json({
      success: false,
      message: "sectionId must be a positive integer",
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         s.id AS student_id,
         s.admission_number,
         s.first_name,
         s.last_name,
         s.roll_number,
         s.class_id,
         s.section_id,
         a.id AS attendance_id,
         a.attendance_date,
         a.status AS attendance_status,
         a.remarks,
         a.marked_by,
         a.updated_at AS marked_at
       FROM students s
       LEFT JOIN student_attendance a
         ON a.student_id = s.id
        AND a.tenant_id = s.tenant_id
        AND a.attendance_date = $2::date
       WHERE s.tenant_id = $1
         AND s.status = 'active'
         AND ($3::bigint IS NULL OR s.class_id = $3)
         AND ($4::bigint IS NULL OR s.section_id = $4)
       ORDER BY
         s.class_id NULLS LAST,
         s.section_id NULLS LAST,
         s.roll_number NULLS LAST,
         s.first_name`,
      [
        req.user.tenantId,
        date,
        classId === undefined ? null : Number(classId),
        sectionId === undefined ? null : Number(sectionId),
      ]
    );

    return res.json({
      success: true,
      date,
      count: result.rowCount,
      attendance: result.rows,
    });
  } catch (error) {
    next(error);
  }
});
// GET /api/attendance/summary?date=2026-10-17
router.get("/summary", async (req, res, next) => {
  try {
    const { date, classId, sectionId } = req.query;

    if (!isValidDate(date)) {
      return res.status(400).json({
        success: false,
        message: "A valid date in YYYY-MM-DD format is required",
      });
    }

    if (classId && !isPositiveInteger(classId)) {
      return res.status(400).json({
        success: false,
        message: "classId must be a positive integer",
      });
    }

    if (sectionId && !isPositiveInteger(sectionId)) {
      return res.status(400).json({
        success: false,
        message: "sectionId must be a positive integer",
      });
    }

    const result = await pool.query(
      `SELECT
          COUNT(s.id)::int AS total_students,
          COUNT(a.id)::int AS marked_students,
          COUNT(a.id) FILTER (
            WHERE a.status = 'present'
          )::int AS present,
          COUNT(a.id) FILTER (
            WHERE a.status = 'absent'
          )::int AS absent,
          COUNT(a.id) FILTER (
            WHERE a.status = 'late'
          )::int AS late,
          COUNT(a.id) FILTER (
            WHERE a.status = 'excused'
          )::int AS excused
       FROM students s
       LEFT JOIN student_attendance a
         ON a.student_id = s.id
        AND a.tenant_id = s.tenant_id
        AND a.attendance_date = $2::date
       WHERE s.tenant_id = $1
         AND s.status = 'active'
         AND ($3::bigint IS NULL OR s.class_id = $3)
         AND ($4::bigint IS NULL OR s.section_id = $4)`,
      [
        req.user.tenantId,
        date,
        classId ? Number(classId) : null,
        sectionId ? Number(sectionId) : null,
      ]
    );

    const summary = result.rows[0];

    summary.unmarked =
      summary.total_students - summary.marked_students;

    return res.json({
      success: true,
      date,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

/* PATCH /api/attendance/:id */
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
const { status } = req.body;
const remarksProvided =
  Object.prototype.hasOwnProperty.call(req.body, "remarks");
const remarks = req.body.remarks;
    if (!isPositiveInteger(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid attendance ID",
      });
    }

    if (
      status !== undefined &&
      !ALLOWED_STATUSES.includes(
        String(status).trim().toLowerCase()
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Status must be present, absent, late, or excused",
      });
    }

    if (status === undefined && !("remarks" in req.body)) {
      return res.status(400).json({
        success: false,
        message: "Provide status or remarks to update",
      });
    }

   if (
  remarksProvided &&
  remarks !== null &&
  (typeof remarks !== "string" || remarks.length > 500)
) {
      return res.status(400).json({
        success: false,
        message: "Remarks must be text with at most 500 characters, or null",
      });
    }

    const result = await pool.query(
      `UPDATE student_attendance
       SET status = COALESCE($3, status),
           remarks = CASE
             WHEN $4::boolean THEN $5::varchar
             ELSE remarks
           END,
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
       RETURNING id, student_id, attendance_date,
                 status, remarks, marked_by,
                 created_at, updated_at`,
      [
        Number(id),
        req.user.tenantId,
        status === undefined
          ? null
          : String(status).trim().toLowerCase(),
        remarksProvided,
        remarks,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Attendance record not found",
      });
    }

    return res.json({
      success: true,
      message: "Attendance updated successfully",
      attendance: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

/* GET /api/attendance/student/:studentId
   Optional query parameters: from, to (YYYY-MM-DD) */
router.get("/student/:studentId", async (req, res, next) => {
  const { studentId } = req.params;
  const { from, to } = req.query;

  if (!isPositiveInteger(studentId)) {
    return res.status(400).json({
      success: false,
      message: "A valid student ID is required.",
    });
  }

  if (from !== undefined && !isValidDate(from)) {
    return res.status(400).json({
      success: false,
      message: "from must use YYYY-MM-DD format.",
    });
  }

  if (to !== undefined && !isValidDate(to)) {
    return res.status(400).json({
      success: false,
      message: "to must use YYYY-MM-DD format.",
    });
  }

  if (from && to && from > to) {
    return res.status(400).json({
      success: false,
      message: "'from' must be on or before 'to'.",
    });
  }

  try {
    const student = await pool.query(
      `SELECT id, admission_number, first_name, last_name
       FROM students
       WHERE id = $1 AND tenant_id = $2`,
      [Number(studentId), req.user.tenantId]
    );

    if (student.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found in your school.",
      });
    }

    const result = await pool.query(
      `SELECT id, student_id, attendance_date, status,
              remarks, marked_by, created_at, updated_at
       FROM student_attendance
       WHERE tenant_id = $1
         AND student_id = $2
         AND ($3::date IS NULL OR attendance_date >= $3::date)
         AND ($4::date IS NULL OR attendance_date <= $4::date)
       ORDER BY attendance_date DESC`,
      [
        req.user.tenantId,
        Number(studentId),
        from ?? null,
        to ?? null,
      ]
    );

    return res.json({
      success: true,
      student: student.rows[0],
      count: result.rowCount,
      attendance: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

/* GET /api/attendance/monthly?month=2026-10
   Optional filters: studentId, classId, sectionId */

/* GET /api/attendance/monthly?month=2026-10
   Optional filters: studentId, classId, sectionId */
router.get("/monthly", async (req, res, next) => {
  const { month, studentId, classId, sectionId } = req.query;

  if (
    typeof month !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  ) {
    return res.status(400).json({
      success: false,
      message: "month is required in YYYY-MM format.",
    });
  }

  for (const [field, value] of Object.entries({
    studentId,
    classId,
    sectionId,
  })) {
    if (value !== undefined && !isPositiveInteger(value)) {
      return res.status(400).json({
        success: false,
        message: `${field} must be a positive integer.`,
      });
    }
  }

  try {
    const result = await pool.query(
      `WITH date_range AS (
         SELECT
           $2::date AS month_start,
           LEAST(
             ($2::date + INTERVAL '1 month - 1 day')::date,
             CURRENT_DATE
           ) AS report_end
       ),
       calendar_days AS (
         SELECT generated_day::date AS day
         FROM date_range dr
         CROSS JOIN LATERAL generate_series(
           dr.month_start::timestamp,
           dr.report_end::timestamp,
           INTERVAL '1 day'
         ) AS generated_day
       ),
       working_days AS (
         SELECT
           cd.day,
           COALESCE(
             sc.is_working_day,
             EXTRACT(ISODOW FROM cd.day) BETWEEN 1 AND 5
           ) AS is_working_day
         FROM calendar_days cd
         LEFT JOIN school_calendar sc
           ON sc.tenant_id = $1
          AND sc.holiday_date = cd.day
       ),
       expected AS (
         SELECT COUNT(*) FILTER (
           WHERE is_working_day
         )::int AS expected_days
         FROM working_days
       )
       SELECT
         s.id AS student_id,
         s.admission_number,
         s.first_name,
         s.last_name,
         s.class_id,
         s.section_id,
         expected.expected_days,

         COUNT(a.id) FILTER (
           WHERE wd.day IS NOT NULL
         )::int AS marked_days,

         COUNT(a.id) FILTER (
           WHERE wd.day IS NOT NULL AND a.status = 'present'
         )::int AS present,

         COUNT(a.id) FILTER (
           WHERE wd.day IS NOT NULL AND a.status = 'absent'
         )::int AS absent,

         COUNT(a.id) FILTER (
           WHERE wd.day IS NOT NULL AND a.status = 'late'
         )::int AS late,

         COUNT(a.id) FILTER (
           WHERE wd.day IS NOT NULL AND a.status = 'excused'
         )::int AS excused,

         (
           expected.expected_days
           - COUNT(a.id) FILTER (
               WHERE wd.day IS NOT NULL AND a.status = 'excused'
             )::int
         ) AS percentage_denominator,

         CASE
           WHEN (
             expected.expected_days
             - COUNT(a.id) FILTER (
                 WHERE wd.day IS NOT NULL AND a.status = 'excused'
               )::int
           ) <= 0 THEN 0
           ELSE ROUND(
             100.0 * COUNT(a.id) FILTER (
               WHERE wd.day IS NOT NULL
                 AND a.status IN ('present', 'late')
             ) / (
               expected.expected_days
               - COUNT(a.id) FILTER (
                   WHERE wd.day IS NOT NULL AND a.status = 'excused'
                 )::int
             ),
             2
           )
         END AS attendance_percentage

       FROM students s
       CROSS JOIN expected
       LEFT JOIN student_attendance a
         ON a.student_id = s.id
        AND a.tenant_id = s.tenant_id
        AND a.attendance_date >= $2::date
        AND a.attendance_date < ($2::date + INTERVAL '1 month')
        AND a.attendance_date <= (
          SELECT report_end FROM date_range
        )
       LEFT JOIN working_days wd
         ON wd.day = a.attendance_date
        AND wd.is_working_day = TRUE
       WHERE s.tenant_id = $1
         AND s.status = 'active'
         AND ($3::bigint IS NULL OR s.id = $3)
         AND ($4::bigint IS NULL OR s.class_id = $4)
         AND ($5::bigint IS NULL OR s.section_id = $5)
       GROUP BY
         s.id, s.admission_number, s.first_name, s.last_name,
         s.class_id, s.section_id, expected.expected_days
       ORDER BY
         s.class_id NULLS LAST,
         s.section_id NULLS LAST,
         s.roll_number NULLS LAST,
         s.first_name`,
      [
        req.user.tenantId,
        `${month}-01`,
        studentId === undefined ? null : Number(studentId),
        classId === undefined ? null : Number(classId),
        sectionId === undefined ? null : Number(sectionId),
      ]
    );

    return res.json({
      success: true,
      month,
      count: result.rowCount,
      report: result.rows,
      percentageRule:
        "Present and late count as attended; excused days are excluded from the denominator. Only expected school days up to today are counted.",
    });
  } catch (error) {
    next(error);
  }
});


/* POST /api/attendance/holidays
   Create a holiday or special working day. */
router.post("/holidays", async (req, res, next) => {
  const { holidayDate, holidayName, description = null, isWorkingDay = false } = req.body;

  if (!isValidDate(holidayDate)) {
    return res.status(400).json({
      success: false,
      message: "holidayDate must use YYYY-MM-DD format.",
    });
  }

  if (typeof holidayName !== "string" || !holidayName.trim()) {
    return res.status(400).json({
      success: false,
      message: "holidayName is required.",
    });
  }

  if (holidayName.trim().length > 150) {
    return res.status(400).json({
      success: false,
      message: "holidayName must be at most 150 characters.",
    });
  }

  if (
    description !== null &&
    (typeof description !== "string" || description.length > 500)
  ) {
    return res.status(400).json({
      success: false,
      message: "description must be text of at most 500 characters, or null.",
    });
  }

  if (typeof isWorkingDay !== "boolean") {
    return res.status(400).json({
      success: false,
      message: "isWorkingDay must be true or false.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO school_calendar
         (tenant_id, holiday_date, holiday_name, description, is_working_day)
       VALUES ($1, $2::date, $3, $4, $5)
       RETURNING id, holiday_date, holiday_name, description,
                 is_working_day, created_at, updated_at`,
      [
        req.user.tenantId,
        holidayDate,
        holidayName.trim(),
        description,
        isWorkingDay,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "School calendar entry created successfully.",
      calendarEntry: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A calendar entry already exists for this date.",
      });
    }
    next(error);
  }
});


/* GET /api/attendance/holidays?from=2026-10-01&to=2026-10-31 */
router.get("/holidays", async (req, res, next) => {
  const { from, to } = req.query;

  if (from !== undefined && !isValidDate(from)) {
    return res.status(400).json({
      success: false,
      message: "from must use YYYY-MM-DD format.",
    });
  }

  if (to !== undefined && !isValidDate(to)) {
    return res.status(400).json({
      success: false,
      message: "to must use YYYY-MM-DD format.",
    });
  }

  if (from && to && from > to) {
    return res.status(400).json({
      success: false,
      message: "from must be on or before to.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, holiday_date, holiday_name, description,
              is_working_day, created_at, updated_at
       FROM school_calendar
       WHERE tenant_id = $1
         AND ($2::date IS NULL OR holiday_date >= $2::date)
         AND ($3::date IS NULL OR holiday_date <= $3::date)
       ORDER BY holiday_date`,
      [req.user.tenantId, from ?? null, to ?? null]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      calendar: result.rows,
    });
  } catch (error) {
    next(error);
  }
});


/* PATCH /api/attendance/holidays/:id */
router.patch("/holidays/:id", async (req, res, next) => {
  const { id } = req.params;
  const body = req.body;

  if (!isPositiveInteger(id)) {
    return res.status(400).json({
      success: false,
      message: "A valid calendar entry ID is required.",
    });
  }

  const fields = {
    holidayDate: "holiday_date",
    holidayName: "holiday_name",
    description: "description",
    isWorkingDay: "is_working_day",
  };

  const updates = [];
  const values = [];

  for (const [field, column] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;

    const value = body[field];

    if (field === "holidayDate" && !isValidDate(value)) {
      return res.status(400).json({
        success: false,
        message: "holidayDate must use YYYY-MM-DD format.",
      });
    }

    if (
      field === "holidayName" &&
      (typeof value !== "string" || !value.trim() || value.trim().length > 150)
    ) {
      return res.status(400).json({
        success: false,
        message: "holidayName must be a non-empty string of at most 150 characters.",
      });
    }

    if (
      field === "description" &&
      value !== null &&
      (typeof value !== "string" || value.length > 500)
    ) {
      return res.status(400).json({
        success: false,
        message: "description must be text of at most 500 characters, or null.",
      });
    }

    if (field === "isWorkingDay" && typeof value !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "isWorkingDay must be true or false.",
      });
    }

    values.push(field === "holidayName" ? value.trim() : value);
    updates.push(`${column} = $${values.length}`);
  }

  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one calendar field to update.",
    });
  }

  try {
    values.push(id);
    const idPosition = values.length;

    values.push(req.user.tenantId);
    const tenantPosition = values.length;

    const result = await pool.query(
      `UPDATE school_calendar
       SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${idPosition} AND tenant_id = $${tenantPosition}
       RETURNING id, holiday_date, holiday_name, description,
                 is_working_day, created_at, updated_at`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Calendar entry not found for this school.",
      });
    }

    return res.json({
      success: true,
      message: "Calendar entry updated successfully.",
      calendarEntry: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A calendar entry already exists for that date.",
      });
    }
    next(error);
  }
});


/* DELETE /api/attendance/holidays/:id */
router.delete("/holidays/:id", async (req, res, next) => {
  const { id } = req.params;

  if (!isPositiveInteger(id)) {
    return res.status(400).json({
      success: false,
      message: "A valid calendar entry ID is required.",
    });
  }

  try {
    const result = await pool.query(
      `DELETE FROM school_calendar
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, holiday_date, holiday_name`,
      [Number(id), req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Calendar entry not found for this school.",
      });
    }

    return res.json({
      success: true,
      message: "Calendar entry deleted successfully.",
      calendarEntry: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});


function isSchoolAdmin(req) {
  return (
    Array.isArray(req.user.roles) &&
    req.user.roles.includes("school_admin")
  );
}

function validPositiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0;
}

// Count inclusive calendar days.
// This implementation includes weekends and holidays.
function countLeaveDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  return Math.round((end - start) / 86400000) + 1;
}

// GET /api/leave/balances?staffId=1&year=2026
router.get("/balances", async (req, res) => {
  try {
    const year = req.query.year === undefined
      ? new Date().getUTCFullYear()
      : Number(req.query.year);

    if (!Number.isInteger(year) || year < 2000 || year > 2200) {
      return res.status(400).json({
        success: false,
        message: "Invalid leave year",
      });
    }

    const values = [req.user.tenantId, year];
    let staffFilter = "";

    if (req.query.staffId !== undefined) {
      if (!validPositiveId(req.query.staffId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid staffId",
        });
      }

      values.push(Number(req.query.staffId));
      staffFilter = `AND b.staff_id = $${values.length}`;
    }

    const result = await pool.query(
      `SELECT
         b.*,
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

// PUT /api/leave/balances
// School admin configures a staff member's annual allowance.
router.put("/balances", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can configure leave balances",
    });
  }

  const {
    staffId,
    leaveYear,
    leaveType,
    allocatedDays,
  } = req.body || {};

  const year = Number(leaveYear);
  const allocation = Number(allocatedDays);

  if (!validPositiveId(staffId)) {
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
    Math.round(allocation * 100) !== allocation * 100
  ) {
    return res.status(400).json({
      success: false,
      message: "allocatedDays must be between 0 and 9999.99 with at most 2 decimal places",
    });
  }

  try {
    const staff = await pool.query(
      `SELECT id
       FROM staff
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
    console.error("Set leave balance error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to save leave allowance",
    });
  }
});

// PATCH /api/leave/:id/approve
router.patch("/:id/approve", async (req, res) => {
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

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const requestResult = await client.query(
      `SELECT *
       FROM staff_leave_requests
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [leaveId, req.user.tenantId]
    );

    if (requestResult.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Leave request not found",
      });
    }

    const leave = requestResult.rows[0];

    if (leave.status !== "pending") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "Only pending leave requests can be approved",
      });
    }

    // Paid leave is deducted by calendar year.
    // Unpaid and other leave do not consume these balances.
    const paidTypes = ["casual", "sick", "earned"];

    if (paidTypes.includes(leave.leave_type)) {
      const days = countLeaveDays(
        String(leave.start_date).slice(0, 10),
        String(leave.end_date).slice(0, 10)
      );

      const firstYear = Number(
        String(leave.start_date).slice(0, 4)
      );
      const lastYear = Number(
        String(leave.end_date).slice(0, 4)
      );

      const yearlyDays = new Map();

      for (let year = firstYear; year <= lastYear; year++) {
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;
        const segmentStart =
          String(leave.start_date).slice(0, 10) > yearStart
            ? String(leave.start_date).slice(0, 10)
            : yearStart;
        const segmentEnd =
          String(leave.end_date).slice(0, 10) < yearEnd
            ? String(leave.end_date).slice(0, 10)
            : yearEnd;

        yearlyDays.set(
          year,
          countLeaveDays(segmentStart, segmentEnd)
        );
      }

      // Lock and validate each year's balance before deducting.
      for (const [year, yearDays] of yearlyDays) {
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
          transactionStarted = false;

          return res.status(409).json({
            success: false,
            message: `No ${leave.leave_type} leave allowance configured for ${year}`,
          });
        }

        const balance = balanceResult.rows[0];
        const remaining =
          Number(balance.allocated_days) - Number(balance.used_days);

        if (remaining < yearDays) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return res.status(409).json({
            success: false,
            message: `Insufficient ${leave.leave_type} leave balance for ${year}`,
            remainingDays: remaining,
            requestedDays: yearDays,
          });
        }

        const updateBalance = await client.query(
          `UPDATE staff_leave_balances
           SET used_days = used_days + $1,
               updated_at = NOW()
           WHERE id = $2
             AND used_days + $1 <= allocated_days
           RETURNING id`,
          [yearDays, balance.id]
        );

        if (updateBalance.rowCount === 0) {
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
       WHERE id = $3
       RETURNING *`,
      [
        req.user.id,
        typeof req.body?.reviewComment === "string"
          ? req.body.reviewComment.trim()
          : null,
        leaveId,
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Leave request approved successfully",
      leaveRequest: approved.rows[0],
    });
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("Approve leave request error:", error);

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
        message: "Pending leave request not found; it may already have been processed",
      });
    }

    return res.json({
      success: true,
      message: "Leave request rejected successfully",
      leaveRequest: result.rows[0],
    });
  } catch (error) {
    console.error("Reject leave request error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to reject leave request",
    });
  }
});

module.exports = router;
