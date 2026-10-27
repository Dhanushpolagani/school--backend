
const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

// GET /api/transport/vehicles
router.get("/vehicles", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, vehicle_number, vehicle_type, capacity,
              driver_name, driver_phone, status, created_at
       FROM transport_vehicles
       WHERE tenant_id = $1
       ORDER BY id DESC`,
      [req.user.tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      vehicles: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/transport/vehicles
router.post("/vehicles", async (req, res, next) => {
  const {
    vehicleNumber,
    vehicleType,
    capacity,
    driverName = null,
    driverPhone = null,
  } = req.body;

  if (
    typeof vehicleNumber !== "string" ||
    !vehicleNumber.trim() ||
    typeof vehicleType !== "string" ||
    !vehicleType.trim() ||
    !Number.isInteger(capacity) ||
    capacity <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Vehicle number, vehicle type, and positive integer capacity are required.",
    });
  }

  if (
    (driverName !== null && typeof driverName !== "string") ||
    (driverPhone !== null && typeof driverPhone !== "string")
  ) {
    return res.status(400).json({
      success: false,
      message: "Driver name and phone must be strings.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO transport_vehicles
       (tenant_id, vehicle_number, vehicle_type, capacity,
        driver_name, driver_phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, vehicle_number, vehicle_type, capacity,
                 driver_name, driver_phone, status, created_at`,
      [
        req.user.tenantId,
        vehicleNumber.trim(),
        vehicleType.trim(),
        capacity,
        driverName?.trim() || null,
        driverPhone?.trim() || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Vehicle created successfully",
      vehicle: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A vehicle with this number already exists.",
      });
    }
    next(error);
  }
});

/* PATCH /api/transport/vehicles/:id
   Update vehicle details for the authenticated school. */
router.patch("/vehicles/:id", async (req, res, next) => {
  const vehicleId = Number(req.params.id);

  if (!Number.isSafeInteger(vehicleId) || vehicleId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid vehicle ID is required.",
    });
  }

  const allowedFields = {
    vehicleNumber: "vehicle_number",
    vehicleType: "vehicle_type",
    capacity: "capacity",
    driverName: "driver_name",
    driverPhone: "driver_phone",
  };

  const updates = [];
  const values = [];
  const body = req.body;

  for (const [field, column] of Object.entries(allowedFields)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;

    const value = body[field];

    if (field === "vehicleNumber" || field === "vehicleType") {
      if (typeof value !== "string" || !value.trim()) {
        return res.status(400).json({
          success: false,
          message: `${field} must be a non-empty string.`,
        });
      }
      values.push(value.trim());
    } else if (field === "capacity") {
      if (!Number.isSafeInteger(value) || value <= 0) {
        return res.status(400).json({
          success: false,
          message: "Capacity must be a positive integer.",
        });
      }
      values.push(value);
    } else if (field === "driverName" || field === "driverPhone") {
      if (value !== null && typeof value !== "string") {
        return res.status(400).json({
          success: false,
          message: `${field} must be a string or null.`,
        });
      }
      values.push(value === null ? null : value.trim() || null);
    }

    updates.push(`${column} = $${values.length}`);
  }

  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one valid vehicle field to update.",
    });
  }

  try {
    values.push(vehicleId);
    const vehicleIdPosition = values.length;

    values.push(req.user.tenantId);
    const tenantIdPosition = values.length;

    const result = await pool.query(
      `UPDATE transport_vehicles
       SET ${updates.join(", ")}
       WHERE id = $${vehicleIdPosition}
         AND tenant_id = $${tenantIdPosition}
       RETURNING id, vehicle_number, vehicle_type, capacity,
                 driver_name, driver_phone, status, created_at`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found for this school.",
      });
    }

    return res.json({
      success: true,
      message: "Vehicle updated successfully.",
      vehicle: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A vehicle with this number already exists.",
      });
    }
    if (error.code === "23514" || error.code === "22001") {
      return res.status(400).json({
        success: false,
        message: "Vehicle details violate a database constraint.",
      });
    }
    next(error);
  }
});

/* PATCH /api/transport/vehicles/:id/deactivate */

/* PATCH /api/transport/vehicles/:id/deactivate */
router.patch("/vehicles/:id/deactivate", async (req, res, next) => {
  const vehicleId = Number(req.params.id);

  if (!Number.isSafeInteger(vehicleId) || vehicleId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid vehicle ID is required.",
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Lock the vehicle so its status cannot change mid-check.
    const vehicle = await client.query(
      `SELECT id, vehicle_number, status
       FROM transport_vehicles
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [vehicleId, req.user.tenantId]
    );

    if (vehicle.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vehicle not found for this school.",
      });
    }

    const activeRoute = await client.query(
      `SELECT id, route_name
       FROM transport_routes
       WHERE vehicle_id = $1
         AND tenant_id = $2
         AND is_active = TRUE
       LIMIT 1`,
      [vehicleId, req.user.tenantId]
    );

    if (activeRoute.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Cannot deactivate this vehicle while an active route uses it. Reassign the vehicle or deactivate the route first.",
        route: activeRoute.rows[0],
      });
    }

    const result = await client.query(
      `UPDATE transport_vehicles
       SET status = 'inactive',
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, vehicle_number, vehicle_type, capacity,
                 driver_name, driver_phone, status, created_at`,
      [vehicleId, req.user.tenantId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Vehicle deactivated successfully.",
      vehicle: result.rows[0],
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    if (client) client.release();
  }
});


/* PATCH /api/transport/vehicles/:id/activate */
router.patch("/vehicles/:id/activate", async (req, res, next) => {
  const vehicleId = Number(req.params.id);

  if (!Number.isSafeInteger(vehicleId) || vehicleId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid vehicle ID is required.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE transport_vehicles
       SET status = 'active'
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, vehicle_number, vehicle_type, capacity,
                 driver_name, driver_phone, status, created_at`,
      [vehicleId, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found for this school.",
      });
    }

    return res.json({
      success: true,
      message: "Vehicle activated successfully.",
      vehicle: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/transport/routes
router.get("/routes", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.route_name, r.start_location, r.end_location,
              r.vehicle_id, v.vehicle_number, r.monthly_fee,
              r.is_active, r.created_at
       FROM transport_routes r
       LEFT JOIN transport_vehicles v
         ON v.id = r.vehicle_id AND v.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1
       ORDER BY r.id DESC`,
      [req.user.tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      routes: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/transport/routes
router.post("/routes", async (req, res, next) => {
  const {
    routeName,
    startLocation,
    endLocation,
    vehicleId = null,
    monthlyFee = 0,
  } = req.body;

  if (
    typeof routeName !== "string" || !routeName.trim() ||
    typeof startLocation !== "string" || !startLocation.trim() ||
    typeof endLocation !== "string" || !endLocation.trim() ||
    !Number.isFinite(monthlyFee) || monthlyFee < 0 ||
    (vehicleId !== null &&
      (!Number.isSafeInteger(vehicleId) || vehicleId <= 0))
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid route name, start location, end location, monthly fee, and optional vehicle ID are required.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (vehicleId !== null) {
      const vehicle = await client.query(
        `SELECT id FROM transport_vehicles
         WHERE id = $1 AND tenant_id = $2 AND status = 'active'
         FOR UPDATE`,
        [vehicleId, req.user.tenantId]
      );

      if (vehicle.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "Vehicle not found or inactive for this school.",
        });
      }
    }

    const result = await client.query(
      `INSERT INTO transport_routes
       (tenant_id, route_name, start_location, end_location,
        vehicle_id, monthly_fee)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, route_name, start_location, end_location,
                 vehicle_id, monthly_fee, is_active, created_at`,
      [
        req.user.tenantId,
        routeName.trim(),
        startLocation.trim(),
        endLocation.trim(),
        vehicleId,
        monthlyFee,
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Transport route created successfully",
      route: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A route with this name already exists.",
      });
    }
    next(error);
  } finally {
    client.release();
  }
});

// GET /api/transport/stops
router.get("/stops", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.route_id, r.route_name, s.stop_name,
              s.stop_order, s.pickup_time, s.dropoff_time, s.created_at
       FROM transport_stops s
       JOIN transport_routes r
         ON r.id = s.route_id AND r.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1
       ORDER BY s.route_id, s.stop_order`,
      [req.user.tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      stops: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/transport/stops
router.post("/stops", async (req, res, next) => {
  const {
    routeId,
    stopName,
    stopOrder,
    pickupTime = null,
    dropoffTime = null,
  } = req.body;

  const validTime = (value) =>
    value === null ||
    (typeof value === "string" &&
      /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value));

  if (
    !Number.isSafeInteger(routeId) || routeId <= 0 ||
    typeof stopName !== "string" || !stopName.trim() ||
    !Number.isSafeInteger(stopOrder) || stopOrder <= 0 ||
    !validTime(pickupTime) || !validTime(dropoffTime)
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid route ID, stop name, positive stop order, and optional times are required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO transport_stops
       (tenant_id, route_id, stop_name, stop_order, pickup_time, dropoff_time)
       SELECT $1, r.id, $3, $4, $5, $6
       FROM transport_routes r
       WHERE r.id = $2 AND r.tenant_id = $1 AND r.is_active = TRUE
       RETURNING id, route_id, stop_name, stop_order,
                 pickup_time, dropoff_time, created_at`,
      [
        req.user.tenantId,
        routeId,
        stopName.trim(),
        stopOrder,
        pickupTime,
        dropoffTime,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Active route not found for this school.",
      });
    }

    res.status(201).json({
      success: true,
      message: "Transport stop created successfully",
      stop: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "That stop order already exists on this route.",
      });
    }
    next(error);
  }
});

/* PATCH /api/transport/stops/:id */
router.patch("/stops/:id", async (req, res, next) => {
  const stopId = Number(req.params.id);
  const body = req.body;

  if (!Number.isSafeInteger(stopId) || stopId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid stop ID is required.",
    });
  }

  const allowedFields = {
    stopName: "stop_name",
    stopOrder: "stop_order",
    pickupTime: "pickup_time",
    dropoffTime: "dropoff_time",
  };

  const validTime = (value) =>
    value === null ||
    (typeof value === "string" &&
      /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value));

  const updates = [];
  const values = [];

  for (const [field, column] of Object.entries(allowedFields)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;

    const value = body[field];

    if (field === "stopName") {
      if (typeof value !== "string" || !value.trim()) {
        return res.status(400).json({
          success: false,
          message: "stopName must be a non-empty string.",
        });
      }
      values.push(value.trim());
    } else if (field === "stopOrder") {
      if (!Number.isSafeInteger(value) || value <= 0) {
        return res.status(400).json({
          success: false,
          message: "stopOrder must be a positive integer.",
        });
      }
      values.push(value);
    } else {
      if (!validTime(value)) {
        return res.status(400).json({
          success: false,
          message: `${field} must be a valid time (HH:MM or HH:MM:SS) or null.`,
        });
      }
      values.push(value);
    }

    updates.push(`${column} = $${values.length}`);
  }

  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one stop field to update.",
    });
  }

  try {
    values.push(stopId);
    const stopPosition = values.length;

    values.push(req.user.tenantId);
    const tenantPosition = values.length;

    const result = await pool.query(
      `UPDATE transport_stops AS s
       SET ${updates.join(", ")}
       FROM transport_routes AS r
       WHERE s.id = $${stopPosition}
         AND s.tenant_id = $${tenantPosition}
         AND r.id = s.route_id
         AND r.tenant_id = s.tenant_id
         AND r.is_active = TRUE
       RETURNING s.id, s.route_id, s.stop_name, s.stop_order,
                 s.pickup_time, s.dropoff_time, s.created_at`,
      values
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Stop not found for this school or its route is inactive.",
      });
    }

    return res.json({
      success: true,
      message: "Transport stop updated successfully.",
      stop: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "That stop order already exists on this route.",
      });
    }

    if (error.code === "23514" || error.code === "22001") {
      return res.status(400).json({
        success: false,
        message: "Stop details violate a database constraint.",
      });
    }

    next(error);
  }
});

/* DELETE /api/transport/stops/:id */
router.delete("/stops/:id", async (req, res, next) => {
  const stopId = Number(req.params.id);

  if (!Number.isSafeInteger(stopId) || stopId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid stop ID is required.",
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const stop = await client.query(
      `SELECT s.id, s.route_id
       FROM transport_stops AS s
       JOIN transport_routes AS r
         ON r.id = s.route_id
        AND r.tenant_id = s.tenant_id
       WHERE s.id = $1
         AND s.tenant_id = $2
       FOR UPDATE OF s`,
      [stopId, req.user.tenantId]
    );

    if (stop.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Stop not found for this school.",
      });
    }

    // Preserve assignment history: don't delete a referenced stop.
    const assignments = await client.query(
      `SELECT id
       FROM student_transport_assignments
       WHERE stop_id = $1
         AND tenant_id = $2
       LIMIT 1`,
      [stopId, req.user.tenantId]
    );

    if (assignments.rowCount > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message:
          "Cannot delete this stop because transport assignments reference it. Reassign students or remove their stop references first.",
      });
    }

    const result = await client.query(
      `DELETE FROM transport_stops
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, route_id, stop_name, stop_order`,
      [stopId, req.user.tenantId]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Transport stop deleted successfully.",
      stop: result.rows[0],
    });
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    if (error.code === "23503") {
      return res.status(409).json({
        success: false,
        message:
          "Cannot delete this stop because another record references it.",
      });
    }

    next(error);
  } finally {
    if (client) client.release();
  }
});

// GET /api/transport/assignments
router.get("/assignments", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.student_id, s.first_name, s.last_name,
              a.route_id, r.route_name, a.stop_id, st.stop_name,
              a.start_date, a.end_date, a.status, a.created_at
       FROM student_transport_assignments a
       JOIN students s
         ON s.id = a.student_id AND s.tenant_id = a.tenant_id
       JOIN transport_routes r
         ON r.id = a.route_id AND r.tenant_id = a.tenant_id
       LEFT JOIN transport_stops st
         ON st.id = a.stop_id AND st.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1
       ORDER BY a.id DESC`,
      [req.user.tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      assignments: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/transport/assignments
router.post("/assignments", async (req, res, next) => {
  const {
    studentId,
    routeId,
    stopId = null,
    startDate,
    endDate = null,
  } = req.body;

  const validDate = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

  if (
    !Number.isSafeInteger(studentId) || studentId <= 0 ||
    !Number.isSafeInteger(routeId) || routeId <= 0 ||
    (stopId !== null &&
      (!Number.isSafeInteger(stopId) || stopId <= 0)) ||
    (startDate !== undefined && !validDate(startDate)) ||
    (endDate !== null && !validDate(endDate)) ||
    (endDate !== null && startDate !== undefined && endDate < startDate)
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid student ID, route ID, optional stop ID, and dates are required.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const student = await client.query(
      `SELECT id FROM students
       WHERE id = $1 AND tenant_id = $2`,
      [studentId, req.user.tenantId]
    );

    if (student.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Student not found for this school.",
      });
    }

    const route = await client.query(
      `SELECT id FROM transport_routes
       WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE`,
      [routeId, req.user.tenantId]
    );

    if (route.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Active route not found for this school.",
      });
    }

    if (stopId !== null) {
      const stop = await client.query(
        `SELECT id FROM transport_stops
         WHERE id = $1 AND route_id = $2 AND tenant_id = $3`,
        [stopId, routeId, req.user.tenantId]
      );

      if (stop.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "Stop does not belong to the selected route.",
        });
      }
    }

    const result = await client.query(
      `INSERT INTO student_transport_assignments
       (tenant_id, student_id, route_id, stop_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6)
       RETURNING id, student_id, route_id, stop_id,
                 start_date, end_date, status, created_at`,
      [
        req.user.tenantId,
        studentId,
        routeId,
        stopId,
        startDate ?? null,
        endDate,
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Student transport assignment created successfully",
      assignment: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

/* PATCH /api/transport/routes/:id */
router.patch("/routes/:id", async (req, res, next) => {
  const routeId = Number(req.params.id);
  const body = req.body;

  if (!Number.isSafeInteger(routeId) || routeId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid route ID is required.",
    });
  }

  const allowedFields = {
    routeName: "route_name",
    startLocation: "start_location",
    endLocation: "end_location",
    vehicleId: "vehicle_id",
    monthlyFee: "monthly_fee",
  };

  const updates = [];
  const values = [];

  for (const [field, column] of Object.entries(allowedFields)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;

    const value = body[field];

    if (["routeName", "startLocation", "endLocation"].includes(field)) {
      if (typeof value !== "string" || !value.trim()) {
        return res.status(400).json({
          success: false,
          message: `${field} must be a non-empty string.`,
        });
      }
      values.push(value.trim());
    } else if (field === "vehicleId") {
      if (
        value !== null &&
        (!Number.isSafeInteger(value) || value <= 0)
      ) {
        return res.status(400).json({
          success: false,
          message: "vehicleId must be a positive integer or null.",
        });
      }
      values.push(value);
    } else if (field === "monthlyFee") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return res.status(400).json({
          success: false,
          message: "monthlyFee must be a non-negative number.",
        });
      }
      values.push(value);
    }

    updates.push(`${column} = $${values.length}`);
  }

  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one route field to update.",
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const current = await client.query(
      `SELECT id, vehicle_id, is_active
       FROM transport_routes
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [routeId, req.user.tenantId]
    );

    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({
        success: false,
        message: "Route not found for this school.",
      });
    }

    const vehicleWasProvided =
      Object.prototype.hasOwnProperty.call(body, "vehicleId");
    const newVehicleId = vehicleWasProvided
      ? body.vehicleId
      : current.rows[0].vehicle_id;

    if (newVehicleId !== null && newVehicleId !== undefined) {
      const vehicle = await client.query(
        `SELECT id
         FROM transport_vehicles
         WHERE id = $1
           AND tenant_id = $2
           AND status = 'active'
         FOR UPDATE`,
        [newVehicleId, req.user.tenantId]
      );

      if (vehicle.rowCount === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(400).json({
          success: false,
          message: "Assigned vehicle was not found or is inactive for this school.",
        });
      }
    }

    values.push(routeId);
    const routeIdPosition = values.length;

    values.push(req.user.tenantId);
    const tenantIdPosition = values.length;

    const result = await client.query(
      `UPDATE transport_routes
       SET ${updates.join(", ")},
           updated_at = NOW()
       WHERE id = $${routeIdPosition}
         AND tenant_id = $${tenantIdPosition}
       RETURNING id, route_name, start_location, end_location,
                 vehicle_id, monthly_fee, is_active, created_at, updated_at`,
      values
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Transport route updated successfully.",
      route: result.rows[0],
    });
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "A route with this name already exists.",
      });
    }

    if (error.code === "23503") {
      return res.status(400).json({
        success: false,
        message: "The selected vehicle is invalid.",
      });
    }

    next(error);
  } finally {
    if (client) client.release();
  }
});

/* PATCH /api/transport/routes/:id/deactivate */
router.patch("/routes/:id/deactivate", async (req, res, next) => {
  const routeId = Number(req.params.id);

  if (!Number.isSafeInteger(routeId) || routeId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid route ID is required.",
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const route = await client.query(
      `SELECT id, route_name
       FROM transport_routes
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [routeId, req.user.tenantId]
    );

    if (route.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({
        success: false,
        message: "Route not found for this school.",
      });
    }

    const assignments = await client.query(
      `SELECT id
       FROM student_transport_assignments
       WHERE route_id = $1
         AND tenant_id = $2
         AND status = 'active'
         AND (end_date IS NULL OR end_date >= CURRENT_DATE)
       LIMIT 1`,
      [routeId, req.user.tenantId]
    );

    if (assignments.rowCount > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(409).json({
        success: false,
        message:
          "Cannot deactivate this route while active student assignments exist. End or reassign those assignments first.",
      });
    }

    const result = await client.query(
      `UPDATE transport_routes
       SET is_active = FALSE,
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, route_name, start_location, end_location,
                 vehicle_id, monthly_fee, is_active, created_at, updated_at`,
      [routeId, req.user.tenantId]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Transport route deactivated successfully.",
      route: result.rows[0],
    });
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

/* PATCH /api/transport/routes/:id/activate */
router.patch("/routes/:id/activate", async (req, res, next) => {
  const routeId = Number(req.params.id);

  if (!Number.isSafeInteger(routeId) || routeId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid route ID is required.",
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const route = await client.query(
      `SELECT id, vehicle_id
       FROM transport_routes
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [routeId, req.user.tenantId]
    );

    if (route.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({
        success: false,
        message: "Route not found for this school.",
      });
    }

    const vehicleId = route.rows[0].vehicle_id;

    if (vehicleId !== null) {
      const vehicle = await client.query(
        `SELECT id
         FROM transport_vehicles
         WHERE id = $1
           AND tenant_id = $2
           AND status = 'active'
         FOR UPDATE`,
        [vehicleId, req.user.tenantId]
      );

      if (vehicle.rowCount === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(409).json({
          success: false,
          message:
            "Cannot activate this route because its assigned vehicle is missing or inactive. Assign an active vehicle first.",
        });
      }
    }

    const result = await client.query(
      `UPDATE transport_routes
       SET is_active = TRUE,
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, route_name, start_location, end_location,
                 vehicle_id, monthly_fee, is_active, created_at, updated_at`,
      [routeId, req.user.tenantId]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Transport route activated successfully.",
      route: result.rows[0],
    });
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

/* PATCH /api/transport/assignments/:id/end */
router.patch("/assignments/:id/end", async (req, res, next) => {
  const assignmentId = Number(req.params.id);

  if (!Number.isSafeInteger(assignmentId) || assignmentId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid assignment ID is required.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE student_transport_assignments
       SET status = 'inactive',
           end_date = GREATEST(start_date, CURRENT_DATE)
       WHERE id = $1
         AND tenant_id = $2
         AND status = 'active'
         AND (end_date IS NULL OR end_date >= CURRENT_DATE)
       RETURNING id, student_id, route_id, stop_id,
                 start_date, end_date, status, created_at`,
      [assignmentId, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Active assignment not found for this school.",
      });
    }

    return res.json({
      success: true,
      message: "Student transport assignment ended successfully.",
      assignment: result.rows[0],
    });
  } catch (error) {
    next(error);
  }

});

function isValidAssignmentDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

/* PATCH /api/transport/assignments/:id */
router.patch("/assignments/:id", async (req, res, next) => {
  const assignmentId = Number(req.params.id);
  const body = req.body;

  if (!Number.isSafeInteger(assignmentId) || assignmentId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid assignment ID is required.",
    });
  }

  const hasStart = Object.prototype.hasOwnProperty.call(body, "startDate");
  const hasEnd = Object.prototype.hasOwnProperty.call(body, "endDate");

  if (!hasStart && !hasEnd) {
    return res.status(400).json({
      success: false,
      message: "Provide startDate or endDate to update.",
    });
  }

  if (hasStart && !isValidAssignmentDate(body.startDate)) {
    return res.status(400).json({
      success: false,
      message: "startDate must be a valid YYYY-MM-DD date.",
    });
  }

  if (
    hasEnd &&
    body.endDate !== null &&
    !isValidAssignmentDate(body.endDate)
  ) {
    return res.status(400).json({
      success: false,
      message: "endDate must be a valid YYYY-MM-DD date or null.",
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const current = await client.query(
      `SELECT id, student_id, start_date, end_date, status
       FROM student_transport_assignments
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [assignmentId, req.user.tenantId]
    );

    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Assignment not found for this school.",
      });
    }

    const assignment = current.rows[0];

    if (assignment.status !== "active") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "Only active assignments can be updated.",
      });
    }

    const startDate = hasStart
      ? body.startDate
      : assignment.start_date.toISOString().slice(0, 10);

    const endDate = hasEnd ? body.endDate : assignment.end_date
      ? assignment.end_date.toISOString().slice(0, 10)
      : null;

    if (endDate !== null && endDate < startDate) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        success: false,
        message: "endDate cannot be earlier than startDate.",
      });
    }

    const conflict = await client.query(
      `SELECT id
       FROM student_transport_assignments
       WHERE tenant_id = $1
         AND student_id = $2
         AND status = 'active'
         AND id <> $3
         AND start_date <= COALESCE($5::date, 'infinity'::date)
         AND COALESCE(end_date, 'infinity'::date) >= $4::date
       LIMIT 1`,
      [
        req.user.tenantId,
        assignment.student_id,
        assignmentId,
        startDate,
        endDate,
      ]
    );

    if (conflict.rowCount > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "These dates overlap another active transport assignment for this student.",
      });
    }

    const result = await client.query(
      `UPDATE student_transport_assignments
       SET start_date = $1, end_date = $2
       WHERE id = $3 AND tenant_id = $4
       RETURNING id, student_id, route_id, stop_id,
                 start_date, end_date, status, created_at`,
      [startDate, endDate, assignmentId, req.user.tenantId]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Transport assignment updated successfully.",
      assignment: result.rows[0],
    });
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

/* PATCH /api/transport/assignments/:id/reassign */
router.patch("/assignments/:id/reassign", async (req, res, next) => {
  const assignmentId = Number(req.params.id);
  const body = req.body;

  if (!Number.isSafeInteger(assignmentId) || assignmentId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid assignment ID is required.",
    });
  }

  const hasRoute = Object.prototype.hasOwnProperty.call(body, "routeId");
  const hasStop = Object.prototype.hasOwnProperty.call(body, "stopId");

  if (!hasRoute && !hasStop) {
    return res.status(400).json({
      success: false,
      message: "Provide routeId or stopId to reassign transport.",
    });
  }

  if (
    hasRoute &&
    (!Number.isSafeInteger(body.routeId) || body.routeId <= 0)
  ) {
    return res.status(400).json({
      success: false,
      message: "routeId must be a positive integer.",
    });
  }

  if (
    hasStop &&
    body.stopId !== null &&
    (!Number.isSafeInteger(body.stopId) || body.stopId <= 0)
  ) {
    return res.status(400).json({
      success: false,
      message: "stopId must be a positive integer or null.",
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const current = await client.query(
      `SELECT id, student_id, route_id, stop_id, status
       FROM student_transport_assignments
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [assignmentId, req.user.tenantId]
    );

    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Assignment not found for this school.",
      });
    }

    const assignment = current.rows[0];

    if (assignment.status !== "active") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "Only active assignments can be reassigned.",
      });
    }

    const routeId = hasRoute ? body.routeId : Number(assignment.route_id);
    const routeChanged = String(routeId) !== String(assignment.route_id);

    const stopId = hasStop
      ? body.stopId
      : routeChanged
        ? null
        : assignment.stop_id === null
          ? null
          : Number(assignment.stop_id);

    const route = await client.query(
      `SELECT id
       FROM transport_routes
       WHERE id = $1
         AND tenant_id = $2
         AND is_active = TRUE
       FOR UPDATE`,
      [routeId, req.user.tenantId]
    );

    if (route.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        success: false,
        message: "The selected route is missing or inactive for this school.",
      });
    }

    if (stopId !== null) {
      const stop = await client.query(
        `SELECT id
         FROM transport_stops
         WHERE id = $1
           AND route_id = $2
           AND tenant_id = $3`,
        [stopId, routeId, req.user.tenantId]
      );

      if (stop.rowCount === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          success: false,
          message: "The selected stop does not belong to the selected route.",
        });
      }
    }

    const conflict = await client.query(
      `SELECT id
       FROM student_transport_assignments
       WHERE tenant_id = $1
         AND student_id = $2
         AND status = 'active'
         AND id <> $3
         AND start_date <= COALESCE(end_date, 'infinity'::date)
         AND (end_date IS NULL OR end_date >= CURRENT_DATE)
       LIMIT 1`,
      [req.user.tenantId, assignment.student_id, assignmentId]
    );

    if (conflict.rowCount > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "This student has another active transport assignment. Resolve it before reassignment.",
      });
    }

    const result = await client.query(
      `UPDATE student_transport_assignments
       SET route_id = $1, stop_id = $2
       WHERE id = $3 AND tenant_id = $4
       RETURNING id, student_id, route_id, stop_id,
                 start_date, end_date, status, created_at`,
      [routeId, stopId, assignmentId, req.user.tenantId]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.json({
      success: true,
      message: "Student transport reassigned successfully.",
      assignment: result.rows[0],
    });
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

/* PATCH /api/transport/assignments/:id/reactivate */
router.patch("/assignments/:id/reactivate", async (req, res, next) => {
  const assignmentId = Number(req.params.id);

  if (!Number.isSafeInteger(assignmentId) || assignmentId <= 0) {
    return res.status(400).json({
      success: false,
      message: "A valid assignment ID is required.",
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT a.id, a.student_id, a.route_id, a.stop_id,
              a.start_date, a.end_date, a.status,
              r.is_active
       FROM student_transport_assignments a
       JOIN transport_routes r
         ON r.id = a.route_id AND r.tenant_id = a.tenant_id
       WHERE a.id = $1 AND a.tenant_id = $2
       FOR UPDATE OF a`,
      [assignmentId, req.user.tenantId]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Assignment not found for this school.",
      });
    }

    const assignment = result.rows[0];

    if (assignment.status === "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Assignment is already active.",
      });
    }

    if (!assignment.is_active) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Reactivate the route before reactivating this assignment.",
      });
    }

    if (assignment.stop_id !== null) {
      const stop = await client.query(
        `SELECT id FROM transport_stops
         WHERE id = $1 AND route_id = $2 AND tenant_id = $3`,
        [assignment.stop_id, assignment.route_id, req.user.tenantId]
      );

      if (stop.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "The assignment stop is no longer valid. Reassign it first.",
        });
      }
    }

    const conflict = await client.query(
      `SELECT id
       FROM student_transport_assignments
       WHERE tenant_id = $1
         AND student_id = $2
         AND id <> $3
         AND status = 'active'
         AND start_date <= COALESCE($5::date, 'infinity'::date)
         AND COALESCE(end_date, 'infinity'::date) >= $4::date
       LIMIT 1`,
      [
        req.user.tenantId,
        assignment.student_id,
        assignmentId,
        assignment.start_date,
        assignment.end_date,
      ]
    );

    if (conflict.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Another active assignment overlaps this assignment's dates.",
      });
    }

    const updated = await client.query(
      `UPDATE student_transport_assignments
       SET status = 'active',
           end_date = NULL
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, student_id, route_id, stop_id,
                 start_date, end_date, status, created_at`,
      [assignmentId, req.user.tenantId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Assignment reactivated successfully.",
      assignment: updated.rows[0],
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    if (client) client.release();
  }
});


module.exports = router;
