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

// GET /api/purchase-orders/summary
// High-level statistics on purchase orders
router.get("/summary", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) AS total_orders,
         COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
         COUNT(*) FILTER (WHERE status = 'pending_approval') AS pending_approval_count,
         COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
         COUNT(*) FILTER (WHERE status = 'ordered') AS ordered_count,
         COUNT(*) FILTER (WHERE status = 'partially_received') AS partially_received_count,
         COUNT(*) FILTER (WHERE status = 'received') AS received_count,
         COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
         COALESCE(SUM(total_amount), 0) AS total_value,
         COALESCE(SUM(total_amount) FILTER (WHERE status IN ('approved', 'ordered', 'partially_received', 'received')), 0) AS committed_value
       FROM purchase_orders
       WHERE tenant_id = $1`,
      [tenantId]
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/purchase-orders
// List purchase orders with filtering & pagination
router.get("/", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const {
      status,
      supplierId,
      search,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = req.query;

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (parsedPage - 1) * parsedLimit;

    const conditions = ["po.tenant_id = $1"];
    const params = [tenantId];
    let paramIndex = 2;

    if (status && typeof status === "string") {
      conditions.push(`po.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (supplierId && isPositiveId(supplierId)) {
      conditions.push(`po.supplier_id = $${paramIndex}`);
      params.push(supplierId);
      paramIndex++;
    }

    if (startDate) {
      conditions.push(`po.order_date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`po.order_date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    if (search && typeof search === "string" && search.trim()) {
      conditions.push(`(po.po_number ILIKE $${paramIndex} OR s.name ILIKE $${paramIndex})`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    const whereClause = conditions.join(" AND ");

    const countResult = await pool.query(
      `SELECT COUNT(*)
       FROM purchase_orders po
       LEFT JOIN inventory_suppliers s ON s.tenant_id = po.tenant_id AND s.id = po.supplier_id
       WHERE ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    const query = `
      SELECT
        po.id,
        po.tenant_id,
        po.po_number,
        po.supplier_id,
        s.name AS supplier_name,
        s.email AS supplier_email,
        s.phone AS supplier_phone,
        po.order_date,
        po.expected_delivery_date,
        po.status,
        po.subtotal_amount,
        po.tax_amount,
        po.discount_amount,
        po.total_amount,
        po.payment_terms,
        po.created_at,
        po.updated_at,
        (SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id) AS item_count
      FROM purchase_orders po
      LEFT JOIN inventory_suppliers s ON s.tenant_id = po.tenant_id AND s.id = po.supplier_id
      WHERE ${whereClause}
      ORDER BY po.id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(parsedLimit, offset);
    const listResult = await pool.query(query, params);

    res.json({
      success: true,
      data: listResult.rows,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / parsedLimit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/purchase-orders/:id
// Get details of a single purchase order including line items
router.get("/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  if (!isPositiveId(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid purchase order ID format.",
    });
  }

  try {
    const poResult = await pool.query(
      `SELECT
         po.*,
         s.name AS supplier_name,
         s.contact_person AS supplier_contact_person,
         s.email AS supplier_email,
         s.phone AS supplier_phone,
         s.address AS supplier_address,
         s.tax_number AS supplier_tax_number
       FROM purchase_orders po
       LEFT JOIN inventory_suppliers s ON s.tenant_id = po.tenant_id AND s.id = po.supplier_id
       WHERE po.tenant_id = $1 AND po.id = $2`,
      [tenantId, id]
    );

    if (poResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found.",
      });
    }

    const itemsResult = await pool.query(
      `SELECT
         poi.*,
         i.name AS item_name,
         i.item_code,
         i.unit,
         i.quantity_on_hand
       FROM purchase_order_items poi
       JOIN inventory_items i ON i.tenant_id = poi.tenant_id AND i.id = poi.item_id
       WHERE poi.tenant_id = $1 AND poi.purchase_order_id = $2
       ORDER BY poi.id ASC`,
      [tenantId, id]
    );

    const po = poResult.rows[0];
    po.items = itemsResult.rows;

    res.json({
      success: true,
      data: po,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/purchase-orders
// Create a new purchase order with line items
router.post("/", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const {
    supplierId,
    orderDate,
    expectedDeliveryDate,
    shippingAddress,
    paymentTerms,
    notes,
    taxAmount = 0,
    discountAmount = 0,
    items,
  } = req.body;

  if (!supplierId || !isPositiveId(supplierId)) {
    return res.status(400).json({
      success: false,
      message: "A valid supplierId is required.",
    });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      success: false,
      message: "At least one item must be included in the purchase order.",
    });
  }

  // Validate items
  for (const item of items) {
    if (!item.itemId || !isPositiveId(item.itemId)) {
      return res.status(400).json({
        success: false,
        message: "Each item must have a valid itemId.",
      });
    }
    if (!item.quantityOrdered || Number(item.quantityOrdered) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Item quantityOrdered must be greater than 0.",
      });
    }
    if (item.unitPrice === undefined || Number(item.unitPrice) < 0) {
      return res.status(400).json({
        success: false,
        message: "Item unitPrice must be non-negative.",
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verify supplier exists
    const supplierCheck = await client.query(
      `SELECT id, name FROM inventory_suppliers WHERE tenant_id = $1 AND id = $2`,
      [tenantId, supplierId]
    );
    if (supplierCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Supplier not found.",
      });
    }

    // Generate PO number: PO-YYYY-XXXX
    const currentYear = new Date().getFullYear();
    const countRes = await client.query(
      `SELECT COUNT(*) FROM purchase_orders WHERE tenant_id = $1`,
      [tenantId]
    );
    const seq = parseInt(countRes.rows[0].count, 10) + 1;
    const poNumber = `PO-${currentYear}-${String(seq).padStart(4, "0")}`;

    // Calculate subtotal
    let subtotal = 0;
    const calculatedItems = items.map((it) => {
      const qty = parseInt(it.quantityOrdered, 10);
      const price = parseFloat(it.unitPrice);
      const total = qty * price;
      subtotal += total;
      return {
        ...it,
        quantityOrdered: qty,
        unitPrice: price,
        totalPrice: total,
      };
    });

    const tax = parseFloat(taxAmount) || 0;
    const discount = parseFloat(discountAmount) || 0;
    const grandTotal = Math.max(0, subtotal + tax - discount);

    const poInsertRes = await client.query(
      `INSERT INTO purchase_orders (
         tenant_id,
         po_number,
         supplier_id,
         order_date,
         expected_delivery_date,
         status,
         subtotal_amount,
         tax_amount,
         discount_amount,
         total_amount,
         payment_terms,
         shipping_address,
         notes,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        tenantId,
        poNumber,
        supplierId,
        orderDate || new Date(),
        expectedDeliveryDate || null,
        subtotal,
        tax,
        discount,
        grandTotal,
        paymentTerms?.trim() || null,
        shippingAddress?.trim() || null,
        notes?.trim() || null,
        req.user?.id ? Number(req.user.id) : null,
      ]
    );

    const createdPO = poInsertRes.rows[0];

    // Insert items
    for (const item of calculatedItems) {
      await client.query(
        `INSERT INTO purchase_order_items (
           tenant_id,
           purchase_order_id,
           item_id,
           description,
           quantity_ordered,
           quantity_received,
           unit_price,
           total_price
         )
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
        [
          tenantId,
          createdPO.id,
          item.itemId,
          item.description?.trim() || null,
          item.quantityOrdered,
          item.unitPrice,
          item.totalPrice,
        ]
      );
    }

    await client.query("COMMIT");

    await logAudit(req, {
      action: "CREATE",
      entityType: "purchase_order",
      entityId: createdPO.id,
      details: {
        poNumber: createdPO.po_number,
        supplierId,
        totalAmount: grandTotal,
        itemsCount: calculatedItems.length,
      },
    });

    res.status(201).json({
      success: true,
      message: "Purchase order created successfully.",
      data: {
        ...createdPO,
        items: calculatedItems,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

// PATCH /api/purchase-orders/:id/status
// Transition status (e.g., approve, order, cancel)
router.patch("/:id/status", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { status, notes } = req.body;

  const validStatuses = [
    "draft",
    "pending_approval",
    "approved",
    "ordered",
    "cancelled",
  ];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status. Valid values: ${validStatuses.join(", ")}`,
    });
  }

  try {
    const isApproved = status === "approved";

    const result = await pool.query(
      `UPDATE purchase_orders
       SET
         status = $1,
         notes = COALESCE($2, notes),
         approved_by = CASE WHEN $3 THEN $4 ELSE approved_by END,
         approved_at = CASE WHEN $3 THEN NOW() ELSE approved_at END,
         updated_at = NOW()
       WHERE tenant_id = $5 AND id = $6
       RETURNING *`,
      [
        status,
        notes?.trim() || null,
        isApproved,
        req.user?.id ? Number(req.user.id) : null,
        tenantId,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found.",
      });
    }

    await logAudit(req, {
      action: "STATUS_CHANGE",
      entityType: "purchase_order",
      entityId: id,
      details: { newStatus: status, notes },
    });

    res.json({
      success: true,
      message: `Purchase order status changed to ${status}.`,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/purchase-orders/:id/receive
// Goods Received Note (GRN): Receive items against PO, update stock & movement
router.post("/:id/receive", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { receivedItems } = req.body;

  if (!Array.isArray(receivedItems) || receivedItems.length === 0) {
    return res.status(400).json({
      success: false,
      message: "At least one received item with quantity is required.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const poRes = await client.query(
      `SELECT * FROM purchase_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id]
    );

    if (poRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Purchase order not found.",
      });
    }

    const po = poRes.rows[0];

    if (["draft", "cancelled"].includes(po.status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Cannot receive items on a ${po.status} purchase order.`,
      });
    }

    // Process each received item
    for (const rec of receivedItems) {
      const { itemId, quantityReceived, remarks } = rec;
      const qty = parseInt(quantityReceived, 10);

      if (!itemId || !isPositiveId(itemId) || isNaN(qty) || qty <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "Valid itemId and positive quantityReceived required for all items.",
        });
      }

      // Check item in PO
      const poItemRes = await client.query(
        `SELECT * FROM purchase_order_items
         WHERE tenant_id = $1 AND purchase_order_id = $2 AND item_id = $3
         FOR UPDATE`,
        [tenantId, id, itemId]
      );

      if (poItemRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Item ID ${itemId} does not belong to this purchase order.`,
        });
      }

      const poItem = poItemRes.rows[0];
      const newReceived = poItem.quantity_received + qty;

      if (newReceived > poItem.quantity_ordered) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Total received (${newReceived}) cannot exceed ordered (${poItem.quantity_ordered}) for item ID ${itemId}.`,
        });
      }

      // 1. Update purchase_order_items
      await client.query(
        `UPDATE purchase_order_items
         SET quantity_received = $1
         WHERE tenant_id = $2 AND id = $3`,
        [newReceived, tenantId, poItem.id]
      );

      // 2. Increment stock in inventory_items
      await client.query(
        `UPDATE inventory_items
         SET
           quantity_on_hand = quantity_on_hand + $1,
           updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3`,
        [qty, tenantId, itemId]
      );

      // 3. Record in inventory_stock_movements
      await client.query(
        `INSERT INTO inventory_stock_movements (
           tenant_id,
           item_id,
           supplier_id,
           movement_type,
           quantity,
           unit_cost,
           reference_number,
           remarks,
           performed_by
         )
         VALUES ($1, $2, $3, 'receipt', $4, $5, $6, $7, $8)`,
        [
          tenantId,
          itemId,
          po.supplier_id,
          qty,
          poItem.unit_price,
          po.po_number,
          remarks || `Received against PO ${po.po_number}`,
          req.user?.id ? Number(req.user.id) : null,
        ]
      );
    }

    // Check if entire PO is now completely received
    const allItemsRes = await client.query(
      `SELECT
         COUNT(*) AS total_items,
         COUNT(*) FILTER (WHERE quantity_received >= quantity_ordered) AS completed_items
       FROM purchase_order_items
       WHERE tenant_id = $1 AND purchase_order_id = $2`,
      [tenantId, id]
    );

    const stats = allItemsRes.rows[0];
    const newStatus =
      parseInt(stats.completed_items, 10) === parseInt(stats.total_items, 10)
        ? "received"
        : "partially_received";

    const updatedPORes = await client.query(
      `UPDATE purchase_orders
       SET
         status = $1,
         updated_at = NOW()
       WHERE tenant_id = $2 AND id = $3
       RETURNING *`,
      [newStatus, tenantId, id]
    );

    await client.query("COMMIT");

    await logAudit(req, {
      action: "UPDATE",
      entityType: "purchase_order",
      entityId: id,
      details: {
        action: "receive_goods",
        poNumber: po.po_number,
        receivedItems,
        newStatus,
      },
    });

    res.json({
      success: true,
      message: `Goods received successfully. Order is now ${newStatus}.`,
      data: updatedPORes.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

// DELETE /api/purchase-orders/:id
// Delete draft purchase order
router.delete("/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM purchase_orders
       WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
       RETURNING id, po_number`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found or cannot be deleted unless in draft status.",
      });
    }

    await logAudit(req, {
      action: "DELETE",
      entityType: "purchase_order",
      entityId: id,
      details: { deletedPO: result.rows[0] },
    });

    res.json({
      success: true,
      message: "Purchase order deleted successfully.",
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
