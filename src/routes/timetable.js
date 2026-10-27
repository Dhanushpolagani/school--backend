const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();

router.use(authenticateToken);

function isValidId(value) {
  return /^[1-9]\d*$/.test(String(value));
}

// -------------------------------------------------------------
// SCHOOL CALENDAR & HOLIDAYS
// -------------------------------------------------------------

// GET /api/timetable/calendar (or /api/timetable/holidays)
router.get(["/calendar", "/holidays"], async (req, res, next) => {
  try {
    const { year, month } = req.query;
    let query = `
      SELECT id, holiday_date, holiday_name, description, is_working_day, created_at
      FROM school_calendar
      WHERE tenant_id = $1
    `;
    const params = [req.user.tenantId];

    if (year && /^\d{4}$/.test(year)) {
      query += ` AND EXTRACT(YEAR FROM holiday_date) = $${params.length + 1}`;
      params.push(year);
    }
    if (month && /^\d{1,2}$/.test(month)) {
      query += ` AND EXTRACT(MONTH FROM holiday_date) = $${params.length + 1}`;
      params.push(month);
    }

    query += " ORDER BY holiday_date ASC";

    const result = await pool.query(query, params);

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/timetable/calendar
router.post(["/calendar", "/holidays"], async (req, res, next) => {
  const { holidayDate, holidayName, description, isWorkingDay = false } = req.body || {};

  if (!holidayDate || !/^\d{4}-\d{2}-\d{2}$/.test(holidayDate)) {
    return res.status(400).json({
      success: false,
      message: "Valid holidayDate (YYYY-MM-DD) is required.",
    });
  }

  if (!holidayName || typeof holidayName !== "string" || !holidayName.trim()) {
    return res.status(400).json({
      success: false,
      message: "Holiday or event name is required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO school_calendar (tenant_id, holiday_date, holiday_name, description, is_working_day)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, holiday_date)
       DO UPDATE SET holiday_name = EXCLUDED.holiday_name,
                     description = EXCLUDED.description,
                     is_working_day = EXCLUDED.is_working_day,
                     updated_at = NOW()
       RETURNING id, holiday_date, holiday_name, description, is_working_day, created_at`,
      [req.user.tenantId, holidayDate, holidayName.trim(), description?.trim() || null, Boolean(isWorkingDay)]
    );

    await logAudit(req, {
      action: "CREATE",
      entity: "CALENDAR",
      entityId: String(result.rows[0].id),
      details: { holidayDate, holidayName },
    });

    return res.status(201).json({
      success: true,
      message: "Calendar event saved successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/timetable/calendar/:id
router.delete("/calendar/:id", async (req, res, next) => {
  const { id } = req.params;

  if (!isValidId(id)) {
    return res.status(400).json({ success: false, message: "Invalid event ID." });
  }

  try {
    const result = await pool.query(
      "DELETE FROM school_calendar WHERE id = $1 AND tenant_id = $2 RETURNING id",
      [id, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Event not found." });
    }

    return res.json({
      success: true,
      message: "Calendar event removed successfully.",
    });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// CLASS TIMETABLES
// -------------------------------------------------------------

// GET /api/timetable/classes/:classId
router.get("/classes/:classId", async (req, res, next) => {
  const { classId } = req.params;

  if (!isValidId(classId)) {
    return res.status(400).json({ success: false, message: "Invalid class ID." });
  }

  try {
    const classInfo = await pool.query(
      "SELECT id, name FROM school_classes WHERE id = $1 AND tenant_id = $2",
      [classId, req.user.tenantId]
    );

    if (classInfo.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Class not found." });
    }

    // Return structured weekly schedule schema
    return res.json({
      success: true,
      class: classInfo.rows[0],
      schedule: {
        monday: [],
        tuesday: [],
        wednesday: [],
        thursday: [],
        friday: [],
        saturday: [],
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
