
const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

const isSchoolAdmin = (req) =>
  Array.isArray(req.user?.roles) &&
  req.user.roles.includes("school_admin");

const validId = (value) =>
  typeof value === "string" &&
  /^[1-9]\d*$/.test(value);

const validDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
};

const validText = (value, maxLength) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= maxLength;

const validNullableText = (value, maxLength) =>
  value === null ||
  (typeof value === "string" && value.length <= maxLength);

const validMoney = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0 &&
  Number(value) <= 99999999.99;

const validPositiveInteger = (value) =>
  value !== "" &&
  value !== null &&
  value !== undefined &&
  Number.isInteger(Number(value)) &&
  Number(value) > 0;

const validHostelType = (value) =>
  ["boys", "girls", "coed"].includes(value);

const validHostelStatus = (value) =>
  ["active", "inactive"].includes(value);

const validRoomStatus = (value) =>
  ["active", "maintenance", "inactive"].includes(value);

const handleDatabaseError = (res, error, action) => {
  if (error.code === "23505") {
    return res.status(409).json({
      success: false,
      message: "A record with these details already exists."
    });
  }

  console.error(`${action}:`, error);

  return res.status(500).json({
    success: false,
    message: `Unable to ${action.toLowerCase()}.`
  });
};

// =====================================================
// 1. GET ALL HOSTELS
// GET /api/hostel
// =====================================================
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         h.id,
         h.name,
         h.hostel_type,
         h.address,
         h.warden_name,
         h.warden_phone,
         h.status,
         h.created_at,
         COUNT(DISTINCT r.id)::int AS total_rooms,
         COALESCE(SUM(r.capacity), 0)::int AS total_beds,
         COUNT(DISTINCT a.id) FILTER (
           WHERE a.status = 'active'
         )::int AS occupied_beds
       FROM hostels h
       LEFT JOIN hostel_rooms r
         ON r.tenant_id = h.tenant_id
        AND r.hostel_id = h.id
       LEFT JOIN hostel_allocations a
         ON a.tenant_id = r.tenant_id
        AND a.room_id = r.id
       WHERE h.tenant_id = $1
       GROUP BY h.id
       ORDER BY h.name`,
      [req.user.tenantId]
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Retrieve hostels");
  }
});

// =====================================================
// 2. CREATE HOSTEL
// POST /api/hostel
// =====================================================
router.post("/", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can create hostels."
    });
  }

  const {
    name,
    hostelType,
    address = null,
    wardenName = null,
    wardenPhone = null
  } = req.body;

  if (!validText(name, 120) || !validHostelType(hostelType)) {
    return res.status(400).json({
      success: false,
      message: "A valid name and hostelType (boys, girls, or coed) are required."
    });
  }

  if (
    !validNullableText(address, 5000) ||
    !validNullableText(wardenName, 120) ||
    !validNullableText(wardenPhone, 30)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid address or warden details."
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO hostels (
         tenant_id, name, hostel_type, address,
         warden_name, warden_phone
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.user.tenantId,
        name.trim(),
        hostelType,
        address,
        wardenName,
        wardenPhone
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Hostel created successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Create hostel");
  }
});

// =====================================================
// 3. LIST ROOMS IN A HOSTEL
// GET /api/hostel/:hostelId/rooms
// =====================================================
router.get("/:hostelId/rooms", async (req, res) => {
  const { hostelId } = req.params;

  if (!validId(hostelId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid hostel ID."
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         r.id,
         r.hostel_id,
         r.room_number,
         r.floor_number,
         r.capacity,
         r.monthly_fee,
         r.status,
         r.created_at,
         COUNT(a.id) FILTER (
           WHERE a.status = 'active'
         )::int AS occupied_beds,
         (r.capacity - COUNT(a.id) FILTER (
           WHERE a.status = 'active'
         ))::int AS available_beds
       FROM hostel_rooms r
       LEFT JOIN hostel_allocations a
         ON a.tenant_id = r.tenant_id
        AND a.room_id = r.id
       WHERE r.tenant_id = $1
         AND r.hostel_id = $2
       GROUP BY r.id
       ORDER BY r.floor_number, r.room_number`,
      [req.user.tenantId, hostelId]
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Retrieve hostel rooms");
  }
});

// =====================================================
// 4. CREATE ROOM
// POST /api/hostel/:hostelId/rooms
// =====================================================
router.post("/:hostelId/rooms", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can create rooms."
    });
  }

  const { hostelId } = req.params;
  const {
    roomNumber,
    floorNumber = 0,
    capacity,
    monthlyFee = 0
  } = req.body;

  if (
    !validId(hostelId) ||
    !validText(roomNumber, 30) ||
    !Number.isInteger(Number(floorNumber)) ||
    Number(floorNumber) < -5 ||
    Number(floorNumber) > 100 ||
    !validPositiveInteger(capacity) ||
    Number(capacity) > 1000 ||
    !validMoney(monthlyFee)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid room number, floor, capacity, or monthly fee."
    });
  }

  try {
    const hostel = await pool.query(
      `SELECT id, status
       FROM hostels
       WHERE tenant_id = $1 AND id = $2`,
      [req.user.tenantId, hostelId]
    );

    if (hostel.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Hostel not found."
      });
    }

    if (hostel.rows[0].status !== "active") {
      return res.status(409).json({
        success: false,
        message: "Cannot add rooms to an inactive hostel."
      });
    }

    const result = await pool.query(
      `INSERT INTO hostel_rooms (
         tenant_id, hostel_id, room_number,
         floor_number, capacity, monthly_fee
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.user.tenantId,
        hostelId,
        roomNumber.trim(),
        Number(floorNumber),
        Number(capacity),
        Number(monthlyFee)
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Room created successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Create hostel room");
  }
});

// =====================================================
// 5. GET ALL HOSTEL ALLOCATIONS
// GET /api/hostel/allocations?hostelId=1&status=active
// Optional filters: roomId, studentId
// =====================================================
router.get("/allocations", async (req, res) => {
  const { hostelId, roomId, studentId, status } = req.query;

  if (
    (hostelId !== undefined && !validId(hostelId)) ||
    (roomId !== undefined && !validId(roomId)) ||
    (studentId !== undefined && !validId(studentId)) ||
    (status !== undefined &&
      !["active", "vacated", "cancelled"].includes(status))
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid allocation filter."
    });
  }

  const values = [req.user.tenantId];
  const conditions = ["a.tenant_id = $1"];

  for (const [key, column] of [
    ["hostelId", "a.hostel_id"],
    ["roomId", "a.room_id"],
    ["studentId", "a.student_id"],
    ["status", "a.status"]
  ]) {
    if (req.query[key] !== undefined) {
      values.push(req.query[key]);
      conditions.push(`${column} = $${values.length}`);
    }
  }

  try {
    const result = await pool.query(
      `SELECT
         a.id AS allocation_id,
         a.student_id,
         s.admission_number,
         s.first_name,
         s.last_name,
         s.class_name,
         s.section,
         a.hostel_id,
         h.name AS hostel_name,
         a.room_id,
         r.room_number,
         a.bed_number,
         a.allocated_on,
         a.vacated_on,
         a.status,
         a.monthly_fee,
         a.remarks,
         a.created_at
       FROM hostel_allocations a
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
       ORDER BY a.created_at DESC`,
      values
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Retrieve hostel allocations");
  }
});

// =====================================================
// 6. ALLOCATE A STUDENT TO A BED
// POST /api/hostel/allocations
// =====================================================
router.post("/allocations", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can allocate hostel beds."
    });
  }

  const {
    hostelId,
    roomId,
    studentId,
    bedNumber,
    allocatedOn,
    monthlyFee,
    remarks = null
  } = req.body;

  if (
    !validId(String(hostelId ?? "")) ||
    !validId(String(roomId ?? "")) ||
    !validId(String(studentId ?? "")) ||
    !validPositiveInteger(bedNumber) ||
    !validNullableText(remarks, 2000) ||
    (allocatedOn !== undefined && !validDate(allocatedOn)) ||
    (monthlyFee !== undefined && !validMoney(monthlyFee))
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid allocation data. Check IDs, bedNumber, date, fee, and remarks."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the room and hostel so capacity checks and allocations
    // cannot race against simultaneous requests for the same room.
    const roomResult = await client.query(
      `SELECT
         r.id,
         r.hostel_id,
         r.capacity,
         r.monthly_fee,
         r.status AS room_status,
         h.status AS hostel_status
       FROM hostel_rooms r
       JOIN hostels h
         ON h.id = r.hostel_id
        AND h.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1
         AND r.hostel_id = $2
         AND r.id = $3
       FOR UPDATE OF r, h`,
      [req.user.tenantId, hostelId, roomId]
    );

    if (roomResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Room not found in the selected hostel."
      });
    }

    const room = roomResult.rows[0];

    if (
      room.room_status !== "active" ||
      room.hostel_status !== "active"
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This hostel or room is not accepting allocations."
      });
    }

    if (Number(bedNumber) > Number(room.capacity)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `bedNumber must be between 1 and ${room.capacity}.`
      });
    }

    const studentResult = await client.query(
      `SELECT id
       FROM students
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [req.user.tenantId, studentId]
    );

    if (studentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Student not found in this school."
      });
    }

    const allocationCount = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active')::int AS occupied,
         COUNT(*) FILTER (
           WHERE status = 'active' AND bed_number = $3
         )::int AS bed_occupied
       FROM hostel_allocations
       WHERE tenant_id = $1 AND room_id = $2`,
      [req.user.tenantId, roomId, bedNumber]
    );

    const occupied = allocationCount.rows[0].occupied;
    const bedOccupied = allocationCount.rows[0].bed_occupied;

    if (bedOccupied > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This bed is already occupied."
      });
    }

    if (occupied >= Number(room.capacity)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "This room has reached its capacity."
      });
    }

    const fee = monthlyFee === undefined
      ? Number(room.monthly_fee)
      : Number(monthlyFee);

    const insertResult = await client.query(
      `INSERT INTO hostel_allocations (
         tenant_id, hostel_id, room_id, student_id,
         bed_number, allocated_on, monthly_fee,
         remarks, created_by
       )
       VALUES (
         $1, $2, $3, $4, $5,
         COALESCE($6::date, CURRENT_DATE),
         $7, $8, $9
       )
       RETURNING *`,
      [
        req.user.tenantId,
        hostelId,
        roomId,
        studentId,
        bedNumber,
        allocatedOn || null,
        fee,
        remarks,
        req.user.sub
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Student allocated to hostel successfully.",
      data: insertResult.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Student already has an active hostel allocation, or this bed is occupied."
      });
    }

    return handleDatabaseError(res, error, "Allocate student to hostel");
  } finally {
    client.release();
  }
});

// =====================================================
// 7. CHECK A STUDENT OUT
// PATCH /api/hostel/allocations/:allocationId/checkout
// =====================================================
router.patch(
  "/allocations/:allocationId/checkout",
  async (req, res) => {
    if (!isSchoolAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Only school administrators can check students out."
      });
    }

    const { allocationId } = req.params;
    const vacatedOn = req.body.vacatedOn;

    if (
      !validId(allocationId) ||
      (vacatedOn !== undefined && !validDate(vacatedOn))
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid allocation ID or checkout date."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const allocation = await client.query(
        `SELECT id, allocated_on, status
         FROM hostel_allocations
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [req.user.tenantId, allocationId]
      );

      if (allocation.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          message: "Hostel allocation not found."
        });
      }

      const current = allocation.rows[0];

      if (current.status !== "active") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "This allocation is already checked out or cancelled."
        });
      }

      const checkoutDate =
        vacatedOn || new Date().toISOString().slice(0, 10);

      if (checkoutDate < String(current.allocated_on).slice(0, 10)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "Checkout date cannot be before the allocation date."
        });
      }

      const result = await client.query(
        `UPDATE hostel_allocations
         SET status = 'vacated',
             vacated_on = $3,
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [req.user.tenantId, allocationId, checkoutDate]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Student checked out successfully.",
        data: result.rows[0]
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return handleDatabaseError(res, error, "Check student out");
    } finally {
      client.release();
    }
  }
);

// =====================================================
// 8. HOSTEL OCCUPANCY
// GET /api/hostel/:hostelId/occupancy
// =====================================================
router.get("/:hostelId/occupancy", async (req, res) => {
  const { hostelId } = req.params;

  if (!validId(hostelId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid hostel ID."
    });
  }

  try {
    const hostel = await pool.query(
      `SELECT id, name, hostel_type, status
       FROM hostels
       WHERE tenant_id = $1 AND id = $2`,
      [req.user.tenantId, hostelId]
    );

    if (hostel.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Hostel not found."
      });
    }

    const result = await pool.query(
      `SELECT
         r.id AS room_id,
         r.room_number,
         r.floor_number,
         r.capacity,
         r.status,
         COUNT(a.id) FILTER (
           WHERE a.status = 'active'
         )::int AS occupied_beds,
         (r.capacity - COUNT(a.id) FILTER (
           WHERE a.status = 'active'
         ))::int AS available_beds
       FROM hostel_rooms r
       LEFT JOIN hostel_allocations a
         ON a.tenant_id = r.tenant_id
        AND a.room_id = r.id
       WHERE r.tenant_id = $1
         AND r.hostel_id = $2
       GROUP BY r.id
       ORDER BY r.floor_number, r.room_number`,
      [req.user.tenantId, hostelId]
    );

    const totals = result.rows.reduce(
      (acc, room) => {
        acc.totalRooms += 1;
        acc.totalBeds += Number(room.capacity);
        acc.occupiedBeds += Number(room.occupied_beds);
        acc.availableBeds += Number(room.available_beds);
        return acc;
      },
      {
        totalRooms: 0,
        totalBeds: 0,
        occupiedBeds: 0,
        availableBeds: 0
      }
    );

    return res.json({
      success: true,
      data: {
        hostel: hostel.rows[0],
        summary: totals,
        rooms: result.rows
      }
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Retrieve hostel occupancy");
  }
});

// =====================================================
// 9. GET ONE HOSTEL
// GET /api/hostel/:hostelId
// =====================================================
router.get("/:hostelId", async (req, res) => {
  const { hostelId } = req.params;

  if (!validId(hostelId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid hostel ID."
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         id, name, hostel_type, address,
         warden_name, warden_phone, status,
         created_at, updated_at
       FROM hostels
       WHERE tenant_id = $1 AND id = $2`,
      [req.user.tenantId, hostelId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Hostel not found."
      });
    }

    return res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    return handleDatabaseError(res, error, "Retrieve hostel");
  }
});

// =====================================================
// 10. UPDATE HOSTEL
// PATCH /api/hostel/:hostelId
// =====================================================
router.patch("/:hostelId", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can update hostels."
    });
  }

  const { hostelId } = req.params;
  const allowedFields = [
    "name", "hostelType", "address",
    "wardenName", "wardenPhone", "status"
  ];

  if (!validId(hostelId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid hostel ID."
    });
  }

  if (!allowedFields.some((field) => req.body[field] !== undefined)) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one supported field to update."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT *
       FROM hostels
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [req.user.tenantId, hostelId]
    );

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Hostel not found."
      });
    }

    const old = existing.rows[0];
    const name = req.body.name ?? old.name;
    const hostelType = req.body.hostelType ?? old.hostel_type;
    const address = req.body.address === undefined
      ? old.address : req.body.address;
    const wardenName = req.body.wardenName === undefined
      ? old.warden_name : req.body.wardenName;
    const wardenPhone = req.body.wardenPhone === undefined
      ? old.warden_phone : req.body.wardenPhone;
    const status = req.body.status ?? old.status;

    if (
      !validText(name, 120) ||
      !validHostelType(hostelType) ||
      !validNullableText(address, 5000) ||
      !validNullableText(wardenName, 120) ||
      !validNullableText(wardenPhone, 30) ||
      !validHostelStatus(status)
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid hostel update fields."
      });
    }

    if (status === "inactive") {
      const active = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM hostel_allocations
         WHERE tenant_id = $1
           AND hostel_id = $2
           AND status = 'active'`,
        [req.user.tenantId, hostelId]
      );

      if (active.rows[0].count > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "Check out all active students before deactivating this hostel."
        });
      }
    }

    const result = await client.query(
      `UPDATE hostels
       SET name = $3,
           hostel_type = $4,
           address = $5,
           warden_name = $6,
           warden_phone = $7,
           status = $8,
           updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        req.user.tenantId,
        hostelId,
        name.trim(),
        hostelType,
        address,
        wardenName,
        wardenPhone,
        status
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Hostel updated successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return handleDatabaseError(res, error, "Update hostel");
  } finally {
    client.release();
  }
});

// =====================================================
// 11. UPDATE ROOM
// PATCH /api/hostel/:hostelId/rooms/:roomId
// =====================================================
router.patch("/:hostelId/rooms/:roomId", async (req, res) => {
  if (!isSchoolAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can update rooms."
    });
  }

  const { hostelId, roomId } = req.params;
  const allowedFields = [
    "roomNumber", "floorNumber", "capacity",
    "monthlyFee", "status"
  ];

  if (!validId(hostelId) || !validId(roomId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid hostel or room ID."
    });
  }

  if (!allowedFields.some((field) => req.body[field] !== undefined)) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one supported room field to update."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT *
       FROM hostel_rooms
       WHERE tenant_id = $1
         AND hostel_id = $2
         AND id = $3
       FOR UPDATE`,
      [req.user.tenantId, hostelId, roomId]
    );

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Room not found in this hostel."
      });
    }

    const old = existing.rows[0];
    const roomNumber = req.body.roomNumber ?? old.room_number;
    const floorNumber = req.body.floorNumber ?? old.floor_number;
    const capacity = req.body.capacity ?? old.capacity;
    const monthlyFee = req.body.monthlyFee ?? old.monthly_fee;
    const status = req.body.status ?? old.status;

    if (
      !validText(roomNumber, 30) ||
      !Number.isInteger(Number(floorNumber)) ||
      Number(floorNumber) < -5 ||
      Number(floorNumber) > 100 ||
      !validPositiveInteger(capacity) ||
      Number(capacity) > 1000 ||
      !validMoney(monthlyFee) ||
      !validRoomStatus(status)
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid room update fields."
      });
    }

    const active = await client.query(
      `SELECT
         COUNT(*)::int AS occupied,
         COALESCE(MAX(bed_number), 0)::int AS highest_bed
       FROM hostel_allocations
       WHERE tenant_id = $1 AND room_id = $2 AND status = 'active'`,
      [req.user.tenantId, roomId]
    );

    if (
      Number(capacity) < active.rows[0].occupied ||
      Number(capacity) < active.rows[0].highest_bed
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Capacity cannot be less than current occupancy or an assigned bed number."
      });
    }

    if (status !== "active" && active.rows[0].occupied > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Check out all allocated students before deactivating or maintaining a room."
      });
    }

    const result = await client.query(
      `UPDATE hostel_rooms
       SET room_number = $4,
           floor_number = $5,
           capacity = $6,
           monthly_fee = $7,
           status = $8,
           updated_at = NOW()
       WHERE tenant_id = $1 AND hostel_id = $2 AND id = $3
       RETURNING *`,
      [
        req.user.tenantId,
        hostelId,
        roomId,
        roomNumber.trim(),
        Number(floorNumber),
        Number(capacity),
        Number(monthlyFee),
        status
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Room updated successfully.",
      data: result.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return handleDatabaseError(res, error, "Update hostel room");
  } finally {
    client.release();
  }
});

module.exports = router;
