
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");

router.use(authenticateToken);

function tenantIdOf(req) {
  return req.user?.tenantId;
}

function isPositiveId(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0;
}

function isAdmin(req) {
  const roles = req.user?.roles || [];
  return roles.includes("school_admin") || roles.includes("admin");
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

// GET /api/inventory/summary
router.get("/summary", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM inventory_categories
          WHERE tenant_id = $1 AND status = 'active') AS categories,
         (SELECT COUNT(*) FROM inventory_items
          WHERE tenant_id = $1 AND status = 'active') AS active_items,
         (SELECT COALESCE(SUM(quantity_on_hand), 0)
          FROM inventory_items
          WHERE tenant_id = $1 AND status = 'active') AS total_quantity,
         (SELECT COUNT(*) FROM inventory_items
          WHERE tenant_id = $1
            AND status = 'active'
            AND quantity_on_hand <= reorder_level) AS low_stock_items,
         (SELECT COUNT(*) FROM inventory_suppliers
          WHERE tenant_id = $1 AND status = 'active') AS active_suppliers`,
      [tenantId]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Inventory summary error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch inventory summary.",
    });
  }
});

// POST /api/inventory/categories
router.post("/categories", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can manage inventory categories.",
    });
  }

  const { name, description } = req.body;

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Category name is required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO inventory_categories (tenant_id, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, name) DO NOTHING
       RETURNING id, name, description, status, created_at`,
      [tenantId, name.trim(), description?.trim() || null]
    );

    if (!result.rowCount) {
      return res.status(409).json({
        success: false,
        message: "A category with this name already exists.",
      });
    }

    res.status(201).json({
      success: true,
      message: "Inventory category created.",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Create inventory category error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create inventory category.",
    });
  }
});

// GET /api/inventory/categories
router.get("/categories", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT id, name, description, status, created_at, updated_at
       FROM inventory_categories
       WHERE tenant_id = $1
       ORDER BY name`,
      [tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error("List inventory categories error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch inventory categories.",
    });
  }
});

// POST /api/inventory/items
router.post("/items", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can add inventory items.",
    });
  }

  const {
    categoryId,
    itemCode,
    name,
    description,
    unit = "piece",
    quantityOnHand = 0,
    reorderLevel = 0,
    unitCost = 0,
    location,
  } = req.body;

  if (
    !isPositiveId(categoryId) ||
    typeof itemCode !== "string" ||
    !itemCode.trim() ||
    typeof name !== "string" ||
    !name.trim()
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid categoryId, itemCode, and name are required.",
    });
  }

  if (
    !Number.isSafeInteger(quantityOnHand) ||
    quantityOnHand < 0 ||
    !Number.isSafeInteger(reorderLevel) ||
    reorderLevel < 0 ||
    !Number.isFinite(unitCost) ||
    unitCost < 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Stock, reorder level, and unit cost must be non-negative numbers.",
    });
  }

  if (typeof unit !== "string" || !unit.trim()) {
    return res.status(400).json({
      success: false,
      message: "Unit must be a non-empty string.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const category = await client.query(
      `SELECT id FROM inventory_categories
       WHERE id = $1 AND tenant_id = $2 AND status = 'active'
       FOR SHARE`,
      [categoryId, tenantId]
    );

    if (!category.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Active category not found in your school.",
      });
    }

    const result = await client.query(
      `INSERT INTO inventory_items
         (tenant_id, category_id, item_code, name, description, unit,
          quantity_on_hand, reorder_level, unit_cost, location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        tenantId,
        categoryId,
        itemCode.trim(),
        name.trim(),
        description?.trim() || null,
        unit.trim(),
        quantityOnHand,
        reorderLevel,
        unitCost,
        location?.trim() || null,
      ]
    );

    if (quantityOnHand > 0) {
      await client.query(
        `INSERT INTO inventory_stock_movements
           (tenant_id, item_id, movement_type, quantity, unit_cost, remarks)
         VALUES ($1, $2, 'receipt', $3, $4, $5)`,
        [
          tenantId,
          result.rows[0].id,
          quantityOnHand,
          unitCost,
          "Opening stock",
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Inventory item created.",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "An item with this code already exists.",
      });
    }

    console.error("Create inventory item error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create inventory item.",
    });
  } finally {
    client.release();
  }
});

// GET /api/inventory/items/low-stock
// Keep this before /items/:itemId routes if those are added later.
router.get("/items/low-stock", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT i.*, c.name AS category_name
       FROM inventory_items i
       JOIN inventory_categories c
         ON c.id = i.category_id AND c.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
         AND i.status = 'active'
         AND i.quantity_on_hand <= i.reorder_level
       ORDER BY (i.reorder_level - i.quantity_on_hand) DESC, i.name`,
      [tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error("Low stock report error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch low-stock items.",
    });
  }
});

// GET /api/inventory/items
router.get("/items", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT i.*, c.name AS category_name
       FROM inventory_items i
       JOIN inventory_categories c
         ON c.id = i.category_id AND c.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
       ORDER BY i.name`,
      [tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error("List inventory items error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch inventory items.",
    });
  }
});

// POST /api/inventory/items/:itemId/stock
router.post("/items/:itemId/stock", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can change stock.",
    });
  }

  const { itemId } = req.params;
  const { movementType, quantity, unitCost, referenceNumber, remarks } = req.body;

  if (!isPositiveId(itemId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid item ID.",
    });
  }

  if (!["receipt", "issue", "adjustment"].includes(movementType)) {
    return res.status(400).json({
      success: false,
      message: "movementType must be receipt, issue, or adjustment.",
    });
  }

  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return res.status(400).json({
      success: false,
      message: "Quantity must be a positive integer.",
    });
  }

  if (
    unitCost !== undefined &&
    (!Number.isFinite(unitCost) || unitCost < 0)
  ) {
    return res.status(400).json({
      success: false,
      message: "unitCost must be a non-negative number.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const itemResult = await client.query(
      `SELECT id, quantity_on_hand, unit_cost, status
       FROM inventory_items
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [itemId, tenantId]
    );

    if (!itemResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Inventory item not found.",
      });
    }

    const item = itemResult.rows[0];

    if (item.status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Inactive items cannot have stock movements.",
      });
    }

    let newQuantity = item.quantity_on_hand;

    if (movementType === "receipt") newQuantity += quantity;
    if (movementType === "issue") newQuantity -= quantity;
    if (movementType === "adjustment") newQuantity = quantity;

    if (newQuantity < 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Insufficient stock for this issue.",
        availableQuantity: item.quantity_on_hand,
      });
    }

    const cost = unitCost ?? Number(item.unit_cost);

    const updated = await client.query(
      `UPDATE inventory_items
       SET quantity_on_hand = $1,
           unit_cost = CASE WHEN $2 = 'receipt' THEN $3 ELSE unit_cost END,
           updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5
       RETURNING *`,
      [newQuantity, movementType, cost, itemId, tenantId]
    );

    const movement = await client.query(
      `INSERT INTO inventory_stock_movements
         (tenant_id, item_id, movement_type, quantity, unit_cost,
          reference_number, remarks, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        tenantId,
        itemId,
        movementType,
        quantity,
        cost,
        referenceNumber?.trim() || null,
        remarks?.trim() || null,
        isPositiveId(req.user?.sub) ? Number(req.user.sub) : null,
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Stock updated successfully.",
      data: {
        item: updated.rows[0],
        movement: movement.rows[0],
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Stock movement error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update stock.",
    });
  } finally {
    client.release();
  }
});

// GET /api/inventory/items/:itemId/movements
router.get("/items/:itemId/movements", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { itemId } = req.params;

  if (!isPositiveId(itemId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid item ID.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT *
       FROM inventory_stock_movements
       WHERE tenant_id = $1 AND item_id = $2
       ORDER BY created_at DESC, id DESC`,
      [tenantId, itemId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error("Stock movement history error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch stock movements.",
    });
  }
});

// POST /api/inventory/suppliers
router.post("/suppliers", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can add suppliers.",
    });
  }

  const { name, contactPerson, email, phone, address, taxNumber } = req.body;

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      success: false,
      message: "Supplier name is required.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO inventory_suppliers
         (tenant_id, name, contact_person, email, phone, address, tax_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, contact_person, email, phone, address,
                 tax_number, status, created_at`,
      [
        tenantId,
        name.trim(),
        contactPerson?.trim() || null,
        email?.trim() || null,
        phone?.trim() || null,
        address?.trim() || null,
        taxNumber?.trim() || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Supplier created.",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Create supplier error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create supplier.",
    });
  }
});

// GET /api/inventory/suppliers
router.get("/suppliers", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT id, name, contact_person, email, phone, address,
              tax_number, status, created_at, updated_at
       FROM inventory_suppliers
       WHERE tenant_id = $1
       ORDER BY name`,
      [tenantId]
    );

    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error("List suppliers error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch suppliers.",
    });
  }
});

/* GET /api/inventory/items/:itemId */
router.get("/items/:itemId", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { itemId } = req.params;
  if (!isPositiveId(itemId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid item ID.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT i.*, c.name AS category_name
       FROM inventory_items i
       JOIN inventory_categories c
         ON c.id = i.category_id
        AND c.tenant_id = i.tenant_id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [itemId, tenantId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Inventory item not found.",
      });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Get inventory item error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch inventory item.",
    });
  }
});


/* PATCH /api/inventory/items/:itemId */
router.patch("/items/:itemId", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can update inventory items.",
    });
  }

  const { itemId } = req.params;
  if (!isPositiveId(itemId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid item ID.",
    });
  }

  const allowed = {
    categoryId: "category_id",
    name: "name",
    description: "description",
    unit: "unit",
    reorderLevel: "reorder_level",
    unitCost: "unit_cost",
    location: "location",
    status: "status",
  };

  const updates = [];
  const values = [];
  let index = 1;

  for (const [key, column] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(req.body, key)) continue;

    const value = req.body[key];

    if (["categoryId", "reorderLevel"].includes(key) &&
        (!Number.isSafeInteger(value) || value < (key === "categoryId" ? 1 : 0))) {
      return res.status(400).json({
        success: false,
        message: `${key} has an invalid value.`,
      });
    }

    if (key === "unitCost" &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      return res.status(400).json({
        success: false,
        message: "unitCost must be a non-negative number.",
      });
    }

    if (["name", "unit"].includes(key) &&
        (typeof value !== "string" || !value.trim())) {
      return res.status(400).json({
        success: false,
        message: `${key} must be a non-empty string.`,
      });
    }

    if (key === "status" && !["active", "inactive"].includes(value)) {
      return res.status(400).json({
        success: false,
        message: "status must be active or inactive.",
      });
    }

    if (key === "description" || key === "location") {
      if (value !== null && typeof value !== "string") {
        return res.status(400).json({
          success: false,
          message: `${key} must be a string or null.`,
        });
      }
    }

    values.push(
      typeof value === "string" && ["name", "unit"].includes(key)
        ? value.trim()
        : value
    );
    updates.push(`${column} = $${index++}`);
  }

  if (!updates.length) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one field to update.",
    });
  }

  if (req.body.categoryId !== undefined) {
    try {
      const category = await pool.query(
        `SELECT id FROM inventory_categories
         WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
        [req.body.categoryId, tenantId]
      );

      if (!category.rowCount) {
        return res.status(400).json({
          success: false,
          message: "Active category not found in your school.",
        });
      }
    } catch (error) {
      console.error("Validate inventory category error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to validate category.",
      });
    }
  }

  values.push(itemId, tenantId);

  try {
    const result = await pool.query(
      `UPDATE inventory_items
       SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${index} AND tenant_id = $${index + 1}
       RETURNING *`,
      values
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Inventory item not found.",
      });
    }

    res.json({
      success: true,
      message: "Inventory item updated.",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Update inventory item error:", error);
    res.status(500).json({
      success: false,
      message: error.code === "23505"
        ? "An item with conflicting details already exists."
        : "Failed to update inventory item.",
    });
  }
});

router.patch("/suppliers/:supplierId", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can update suppliers.",
    });
  }

  const { supplierId } = req.params;

  if (!isPositiveId(supplierId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid supplier ID.",
    });
  }

  const allowed = {
    name: "name",
    contactPerson: "contact_person",
    email: "email",
    phone: "phone",
    address: "address",
    taxNumber: "tax_number",
    status: "status",
  };

  const updates = [];
  const values = [];
  let index = 1;

  for (const [key, column] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(req.body, key)) continue;

    const value = req.body[key];

    if (key === "name" && (typeof value !== "string" || !value.trim())) {
      return res.status(400).json({
        success: false,
        message: "Supplier name must be a non-empty string.",
      });
    }

    if (key === "status" && !["active", "inactive"].includes(value)) {
      return res.status(400).json({
        success: false,
        message: "status must be active or inactive.",
      });
    }

    if (key !== "status" && key !== "name" &&
        value !== null && typeof value !== "string") {
      return res.status(400).json({
        success: false,
        message: `${key} must be a string or null.`,
      });
    }

    values.push(typeof value === "string" ? value.trim() : value);
    updates.push(`${column} = $${index++}`);
  }

  if (!updates.length) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one field to update.",
    });
  }

  values.push(supplierId, tenantId);

  try {
    const result = await pool.query(
      `UPDATE inventory_suppliers
       SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${index} AND tenant_id = $${index + 1}
       RETURNING *`,
      values
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found.",
      });
    }

    res.json({
      success: true,
      message: "Supplier updated.",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Update supplier error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update supplier.",
    });
  }
});



/* POST /api/inventory/receipts */
router.post("/receipts", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only school administrators can receive inventory stock.",
    });
  }

  const {
    supplierId,
    itemId,
    quantity,
    unitCost,
    referenceNumber,
    remarks,
  } = req.body;

  if (!isPositiveId(supplierId) || !isPositiveId(itemId)) {
    return res.status(400).json({
      success: false,
      message: "Valid supplierId and itemId are required.",
    });
  }

  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return res.status(400).json({
      success: false,
      message: "quantity must be a positive integer.",
    });
  }

  if (
    unitCost !== undefined &&
    (typeof unitCost !== "number" ||
      !Number.isFinite(unitCost) ||
      unitCost < 0)
  ) {
    return res.status(400).json({
      success: false,
      message: "unitCost must be a non-negative number.",
    });
  }

  if (
    referenceNumber !== undefined &&
    referenceNumber !== null &&
    typeof referenceNumber !== "string"
  ) {
    return res.status(400).json({
      success: false,
      message: "referenceNumber must be a string.",
    });
  }

  if (
    remarks !== undefined &&
    remarks !== null &&
    typeof remarks !== "string"
  ) {
    return res.status(400).json({
      success: false,
      message: "remarks must be a string.",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Confirm that the supplier belongs to this school and is active.
    const supplierResult = await client.query(
      `SELECT id, name
       FROM inventory_suppliers
       WHERE id = $1
         AND tenant_id = $2
         AND status = 'active'
       FOR SHARE`,
      [supplierId, tenantId]
    );

    if (!supplierResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Active supplier not found in your school.",
      });
    }

    // 2. Lock and validate the inventory item.
    const itemResult = await client.query(
      `SELECT id, name, quantity_on_hand, unit_cost, status
       FROM inventory_items
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [itemId, tenantId]
    );

    if (!itemResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Inventory item not found in your school.",
      });
    }

    const item = itemResult.rows[0];

    if (item.status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Cannot receive stock for an inactive item.",
      });
    }

    // 3. Calculate the updated stock quantity.
    const newQuantity = Number(item.quantity_on_hand) + quantity;

    if (!Number.isSafeInteger(newQuantity)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Resulting stock quantity is too large.",
      });
    }

    // Use the supplied cost, or retain the item's existing cost.
    const cost =
      unitCost === undefined ? Number(item.unit_cost) : unitCost;

    // 4. Update the item's stock and unit cost.
    const updatedItem = await client.query(
      `UPDATE inventory_items
       SET quantity_on_hand = $1,
           unit_cost = $2,
           updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4
       RETURNING *`,
      [newQuantity, cost, itemId, tenantId]
    );

    // 5. Record the supplier-linked stock receipt.
    const movement = await client.query(
      `INSERT INTO inventory_stock_movements
         (tenant_id, item_id, supplier_id, movement_type,
          quantity, unit_cost, reference_number, remarks, performed_by)
       VALUES ($1, $2, $3, 'receipt', $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        tenantId,
        itemId,
        supplierId,
        quantity,
        cost,
        referenceNumber?.trim() || null,
        remarks?.trim() || null,
        isPositiveId(req.user?.sub) ? Number(req.user.sub) : null,
      ]
    );

    // 6. Commit both database changes together.
    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Stock receipt recorded successfully.",
      data: {
        supplier: supplierResult.rows[0],
        item: updatedItem.rows[0],
        movement: movement.rows[0],
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Inventory receipt error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to record stock receipt.",
    });
  } finally {
    client.release();
  }
});

/* GET /api/inventory/reports/movements */
router.get("/reports/movements", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { movementType, itemId, supplierId } = req.query;

  const allowedTypes = ["receipt", "issue", "adjustment"];

  if (
    movementType !== undefined &&
    !allowedTypes.includes(movementType)
  ) {
    return res.status(400).json({
      success: false,
      message: "movementType must be receipt, issue, or adjustment.",
    });
  }

  if (
    itemId !== undefined &&
    !isPositiveId(itemId)
  ) {
    return res.status(400).json({
      success: false,
      message: "itemId must be a positive integer.",
    });
  }

  if (
    supplierId !== undefined &&
    !isPositiveId(supplierId)
  ) {
    return res.status(400).json({
      success: false,
      message: "supplierId must be a positive integer.",
    });
  }

  const rawLimit = req.query.limit ?? "50";
  const limit = Number(rawLimit);

  if (
    !/^\d+$/.test(String(rawLimit)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return res.status(400).json({
      success: false,
      message: "limit must be between 1 and 100.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         m.id AS movement_id,
         m.item_id,
         i.item_code,
         i.name AS item_name,
         m.supplier_id,
         s.name AS supplier_name,
         m.movement_type,
         m.quantity,
         m.unit_cost,
         m.reference_number,
         m.remarks,
         m.performed_by,
         m.created_at
       FROM inventory_stock_movements m
       JOIN inventory_items i
         ON i.id = m.item_id
        AND i.tenant_id = m.tenant_id
       LEFT JOIN inventory_suppliers s
         ON s.id = m.supplier_id
        AND s.tenant_id = m.tenant_id
       WHERE m.tenant_id = $1
         AND ($2::text IS NULL OR m.movement_type = $2)
         AND ($3::bigint IS NULL OR m.item_id = $3)
         AND ($4::bigint IS NULL OR m.supplier_id = $4)
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $5`,
      [
        tenantId,
        movementType ?? null,
        itemId ?? null,
        supplierId ?? null,
        limit,
      ]
    );

    return res.status(200).json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error("Inventory movement report error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve inventory movement report.",
    });
  }
});

/* GET /api/inventory/reports/stock */
router.get("/reports/stock", async (req, res) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const lowStockOnly = req.query.lowStockOnly ?? "false";

  if (!["true", "false"].includes(lowStockOnly)) {
    return res.status(400).json({
      success: false,
      message: "lowStockOnly must be true or false.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         i.id AS item_id,
         i.item_code,
         i.name AS item_name,
         i.unit,
         i.quantity_on_hand,
         i.reorder_level,
         i.unit_cost,
         (i.quantity_on_hand * i.unit_cost) AS stock_value,
         i.status,
         c.id AS category_id,
         c.name AS category_name,
         CASE
           WHEN i.quantity_on_hand = 0 THEN 'out_of_stock'
           WHEN i.quantity_on_hand <= i.reorder_level THEN 'low_stock'
           ELSE 'in_stock'
         END AS stock_status
       FROM inventory_items i
       LEFT JOIN inventory_categories c
         ON c.id = i.category_id
        AND c.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
         AND (
           $2::boolean = FALSE
           OR i.quantity_on_hand <= i.reorder_level
         )
       ORDER BY
         CASE
           WHEN i.quantity_on_hand = 0 THEN 0
           WHEN i.quantity_on_hand <= i.reorder_level THEN 1
           ELSE 2
         END,
         i.name ASC`,
      [tenantId, lowStockOnly === "true"]
    );

    const summary = result.rows.reduce(
      (totals, item) => {
        const quantity = Number(item.quantity_on_hand);
        const value = Number(item.stock_value);

        totals.totalItems += 1;
        totals.totalQuantity += quantity;
        totals.totalStockValue += value;

        if (item.stock_status === "out_of_stock") {
          totals.outOfStockItems += 1;
        } else if (item.stock_status === "low_stock") {
          totals.lowStockItems += 1;
        } else {
          totals.inStockItems += 1;
        }

        return totals;
      },
      {
        totalItems: 0,
        totalQuantity: 0,
        totalStockValue: 0,
        outOfStockItems: 0,
        lowStockItems: 0,
        inStockItems: 0,
      }
    );

    return res.status(200).json({
      success: true,
      summary,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    console.error("Inventory stock report error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve inventory stock report.",
    });
  }
});


// Integrated Purchase Orders sub-router
try {
  const purchaseOrdersRouter = require("../services/purchaseOrdersRouter");
  router.use("/purchase-orders", purchaseOrdersRouter);
  router.purchaseOrdersRouter = purchaseOrdersRouter;
} catch (e) {
  console.warn("Could not load purchaseOrdersRouter:", e.message);
}

module.exports = router;
