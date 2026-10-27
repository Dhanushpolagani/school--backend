const express = require("express");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { logAudit } = require("../utils/auditLogger");

const router = express.Router();
console.log("Admissions router loaded");
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

// GET /api/admissions/stats
// Returns summary statistics for admission applications
router.get("/stats", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const statsResult = await pool.query(
      `SELECT
         COUNT(*) AS total_applications,
         COUNT(*) FILTER (WHERE status = 'submitted') AS submitted_count,
         COUNT(*) FILTER (WHERE status = 'under_review') AS under_review_count,
         COUNT(*) FILTER (WHERE status = 'shortlisted') AS shortlisted_count,
         COUNT(*) FILTER (WHERE status = 'interview_scheduled') AS interview_scheduled_count,
         COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
         COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_count,
         COUNT(*) FILTER (WHERE status = 'enrolled') AS enrolled_count,
         COUNT(*) FILTER (WHERE status = 'withdrawn') AS withdrawn_count
       FROM admission_applications
       WHERE tenant_id = $1`,
      [tenantId]
    );

    const classDistribution = await pool.query(
      `SELECT
         COALESCE(applying_class_name, 'Unassigned') AS class_name,
         COUNT(*) AS count
       FROM admission_applications
       WHERE tenant_id = $1
       GROUP BY applying_class_name
       ORDER BY count DESC`,
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        summary: statsResult.rows[0],
        byClass: classDistribution.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admissions/applications
// List admission applications with filtering and pagination
router.get("/applications", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const {
      status,
      academicYear,
      className,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (parsedPage - 1) * parsedLimit;

    const conditions = ["tenant_id = $1"];
    const params = [tenantId];
    let paramIndex = 2;

    if (status && typeof status === "string") {
      conditions.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (academicYear && typeof academicYear === "string") {
      conditions.push(`academic_year = $${paramIndex}`);
      params.push(academicYear);
      paramIndex++;
    }

    if (className && typeof className === "string") {
      conditions.push(`applying_class_name ILIKE $${paramIndex}`);
      params.push(`%${className}%`);
      paramIndex++;
    }

    if (search && typeof search === "string" && search.trim()) {
      conditions.push(`(
        application_number ILIKE $${paramIndex} OR
        first_name ILIKE $${paramIndex} OR
        last_name ILIKE $${paramIndex} OR
        parent_name ILIKE $${paramIndex} OR
        parent_phone ILIKE $${paramIndex}
      )`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    const whereClause = conditions.join(" AND ");

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM admission_applications WHERE ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    const listQuery = `
      SELECT
        id,
        tenant_id,
        application_number,
        academic_year,
        first_name,
        last_name,
        date_of_birth,
        gender,
        applying_class_name,
        applying_section_name,
        parent_name,
        parent_relationship,
        parent_phone,
        parent_email,
        email,
        phone,
        address,
        previous_school,
        previous_grade,
        documents_submitted,
        status,
        review_notes,
        interview_date,
        decision_date,
        admitted_student_id,
        created_at,
        updated_at
      FROM admission_applications
      WHERE ${whereClause}
      ORDER BY id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(parsedLimit, offset);

    const listResult = await pool.query(listQuery, params);

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

// GET /api/admissions/applications/:id
// Get a single admission application by ID
router.get("/applications/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  if (!isPositiveId(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid application ID format.",
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         a.*,
         s.admission_number AS admitted_student_admission_number,
         s.first_name AS student_first_name,
         s.last_name AS student_last_name
       FROM admission_applications a
       LEFT JOIN students s ON s.tenant_id = a.tenant_id AND s.id = a.admitted_student_id
       WHERE a.tenant_id = $1 AND a.id = $2`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Admission application not found.",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admissions/applications
// Submit a new admission application
router.post("/applications", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const {
      academicYear,
      firstName,
      lastName,
      dateOfBirth,
      gender,
      className,
      appliedClass,
      sectionName,
      parentName,
      parentRelationship = "Parent",
      parentPhone,
      parentEmail,
      email,
      phone,
      address,
      previousSchool,
      previousGrade,
      documentsSubmitted = [],
    } = req.body;

    const targetClass = appliedClass || className;

    if (!firstName || typeof firstName !== "string" || !firstName.trim()) {
      return res.status(400).json({
        success: false,
        message: "Applicant first name is required.",
      });
    }

    if (!dateOfBirth) {
      return res.status(400).json({
        success: false,
        message: "Applicant date of birth is required.",
      });
    }

    if (!gender || typeof gender !== "string") {
      return res.status(400).json({
        success: false,
        message: "Applicant gender is required.",
      });
    }

    if (!targetClass || typeof targetClass !== "string" || !targetClass.trim()) {
      return res.status(400).json({
        success: false,
        message: "Class applying for is required.",
      });
    }

    if (!parentName || typeof parentName !== "string" || !parentName.trim()) {
      return res.status(400).json({
        success: false,
        message: "Parent/guardian name is required.",
      });
    }

    if (!parentPhone || typeof parentPhone !== "string" || !parentPhone.trim()) {
      return res.status(400).json({
        success: false,
        message: "Parent phone number is required.",
      });
    }

    const currentYear = new Date().getFullYear();
    const resolvedAcademicYear =
      academicYear && typeof academicYear === "string" && academicYear.trim()
        ? academicYear.trim()
        : `${currentYear}-${currentYear + 1}`;

    // Generate unique application number ADM-YYYY-RANDOM
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM admission_applications WHERE tenant_id = $1`,
      [tenantId]
    );
    const seq = parseInt(countRes.rows[0].count, 10) + 1;
    const applicationNumber = `ADM-${currentYear}-${String(seq).padStart(4, "0")}-${randomSuffix}`;

    const insertResult = await pool.query(
      `INSERT INTO admission_applications (
         tenant_id,
         application_number,
         academic_year,
         first_name,
         last_name,
         date_of_birth,
         gender,
         applying_class_name,
         applying_section_name,
         parent_name,
         parent_relationship,
         parent_phone,
         parent_email,
         email,
         phone,
         address,
         previous_school,
         previous_grade,
         documents_submitted,
         status,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'submitted', $20)
       RETURNING *`,
      [
        tenantId,
        applicationNumber,
        resolvedAcademicYear,
        firstName.trim(),
        lastName?.trim() || null,
        dateOfBirth,
        gender.toLowerCase(),
        targetClass.trim(),
        sectionName?.trim() || null,
        parentName.trim(),
        parentRelationship?.trim() || "Parent",
        parentPhone.trim(),
        parentEmail?.trim() || null,
        email?.trim() || null,
        phone?.trim() || null,
        address?.trim() || null,
        previousSchool?.trim() || null,
        previousGrade?.trim() || null,
        JSON.stringify(Array.isArray(documentsSubmitted) ? documentsSubmitted : []),
        req.user?.id ? Number(req.user.id) : null,
      ]
    );

    const application = insertResult.rows[0];

    await logAudit(req, {
      action: "CREATE",
      entityType: "admission_application",
      entityId: application.id,
      details: {
        applicationNumber: application.application_number,
        studentName: `${application.first_name} ${application.last_name || ""}`.trim(),
        class: application.applying_class_name,
      },
    });

    res.status(201).json({
      success: true,
      message: "Admission application submitted successfully.",
      data: application,
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/admissions/applications/:id
// Update application details
router.put("/applications/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  if (!isPositiveId(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid application ID format.",
    });
  }

  try {
    const {
      firstName,
      lastName,
      dateOfBirth,
      gender,
      className,
      sectionName,
      parentName,
      parentRelationship,
      parentPhone,
      parentEmail,
      email,
      phone,
      address,
      previousSchool,
      previousGrade,
      documentsSubmitted,
      reviewNotes,
    } = req.body;

    const result = await pool.query(
      `UPDATE admission_applications
       SET
         first_name = COALESCE($1, first_name),
         last_name = COALESCE($2, last_name),
         date_of_birth = COALESCE($3, date_of_birth),
         gender = COALESCE($4, gender),
         applying_class_name = COALESCE($5, applying_class_name),
         applying_section_name = COALESCE($6, applying_section_name),
         parent_name = COALESCE($7, parent_name),
         parent_relationship = COALESCE($8, parent_relationship),
         parent_phone = COALESCE($9, parent_phone),
         parent_email = COALESCE($10, parent_email),
         email = COALESCE($11, email),
         phone = COALESCE($12, phone),
         address = COALESCE($13, address),
         previous_school = COALESCE($14, previous_school),
         previous_grade = COALESCE($15, previous_grade),
         documents_submitted = COALESCE($16, documents_submitted),
         review_notes = COALESCE($17, review_notes),
         updated_at = NOW()
       WHERE tenant_id = $18 AND id = $19
       RETURNING *`,
      [
        firstName?.trim() || null,
        lastName?.trim() || null,
        dateOfBirth || null,
        gender?.toLowerCase() || null,
        className?.trim() || null,
        sectionName?.trim() || null,
        parentName?.trim() || null,
        parentRelationship?.trim() || null,
        parentPhone?.trim() || null,
        parentEmail?.trim() || null,
        email?.trim() || null,
        phone?.trim() || null,
        address?.trim() || null,
        previousSchool?.trim() || null,
        previousGrade?.trim() || null,
        documentsSubmitted ? JSON.stringify(documentsSubmitted) : null,
        reviewNotes?.trim() || null,
        tenantId,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Admission application not found.",
      });
    }

    await logAudit(req, {
      action: "UPDATE",
      entityType: "admission_application",
      entityId: id,
      details: { changes: req.body },
    });

    res.json({
      success: true,
      message: "Admission application updated successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admissions/applications/:id/status
// Transition status of application
router.patch("/applications/:id/status", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { status, reviewNotes, decisionRemarks } = req.body;

  const validStatuses = [
    "submitted",
    "under_review",
    "shortlisted",
    "interview_scheduled",
    "approved",
    "rejected",
    "withdrawn",
  ];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status. Valid values: ${validStatuses.join(", ")}`,
    });
  }

  try {
    const isDecision = status === "approved" || status === "rejected";

    const result = await pool.query(
      `UPDATE admission_applications
       SET
         status = $1,
         review_notes = COALESCE($2, review_notes),
         decision_remarks = COALESCE($3, decision_remarks),
         reviewed_by = $4,
         reviewed_at = NOW(),
         decision_date = CASE WHEN $5 THEN NOW() ELSE decision_date END,
         updated_at = NOW()
       WHERE tenant_id = $6 AND id = $7
       RETURNING *`,
      [
        status,
        reviewNotes?.trim() || null,
        decisionRemarks?.trim() || null,
        req.user?.id ? Number(req.user.id) : null,
        isDecision,
        tenantId,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Admission application not found.",
      });
    }

    await logAudit(req, {
      action: "STATUS_CHANGE",
      entityType: "admission_application",
      entityId: id,
      details: { newStatus: status, remarks: reviewNotes || decisionRemarks },
    });

    res.json({
      success: true,
      message: `Application status updated to ${status}.`,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admissions/applications/:id/interview
// Schedule interview for application
router.post("/applications/:id/interview", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const { interviewDate, interviewNotes } = req.body;

  if (!interviewDate) {
    return res.status(400).json({
      success: false,
      message: "Interview date is required.",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE admission_applications
       SET
         status = 'interview_scheduled',
         interview_date = $1,
         interview_notes = COALESCE($2, interview_notes),
         reviewed_by = $3,
         reviewed_at = NOW(),
         updated_at = NOW()
       WHERE tenant_id = $4 AND id = $5
       RETURNING *`,
      [
        interviewDate,
        interviewNotes?.trim() || null,
        req.user?.id ? Number(req.user.id) : null,
        tenantId,
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Admission application not found.",
      });
    }

    await logAudit(req, {
      action: "UPDATE",
      entityType: "admission_application",
      entityId: id,
      details: { action: "schedule_interview", interviewDate },
    });

    res.json({
      success: true,
      message: "Interview scheduled successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admissions/applications/:id/enroll
// Enrol student from approved application (Atomic Transaction)
router.post("/applications/:id/enroll", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;
  const {
    customAdmissionNumber,
    section,
    rollNumber,
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const appRes = await client.query(
      `SELECT * FROM admission_applications
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId, id]
    );

    if (appRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Admission application not found.",
      });
    }

    const app = appRes.rows[0];

    if (app.status === "enrolled" || app.admitted_student_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "This applicant has already been enrolled as a student.",
      });
    }

    // Auto-generate admission number if not provided
    let admissionNumber = customAdmissionNumber;
    if (!admissionNumber || typeof admissionNumber !== "string" || !admissionNumber.trim()) {
      const year = new Date().getFullYear();
      const countRes = await client.query(
        `SELECT COUNT(*) FROM students WHERE tenant_id = $1`,
        [tenantId]
      );
      const studentSeq = parseInt(countRes.rows[0].count, 10) + 1;
      admissionNumber = `STU-${year}-${String(studentSeq).padStart(4, "0")}`;
    }

    // Insert student record
    const studentInsertRes = await client.query(
      `INSERT INTO students (
         tenant_id,
         admission_number,
         first_name,
         last_name,
         date_of_birth,
         gender,
         class_name,
         section,
         roll_number,
         email,
         phone,
         address,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active')
       RETURNING *`,
      [
        tenantId,
        admissionNumber.trim(),
        app.first_name,
        app.last_name || null,
        app.date_of_birth,
        app.gender,
        app.applying_class_name,
        section?.trim() || app.applying_section_name || "A",
        rollNumber?.trim() || null,
        app.email || null,
        app.phone || null,
        app.address || null,
      ]
    );

    const student = studentInsertRes.rows[0];

    // Create parent record if parent details exist
    if (app.parent_name) {
      await client.query(
        `INSERT INTO parents (
           tenant_id,
           student_id,
           full_name,
           relationship,
           phone,
           email,
           address
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          student.id,
          app.parent_name,
          app.parent_relationship || "Parent",
          app.parent_phone,
          app.parent_email || null,
          app.address || null,
        ]
      );
    }

    // Update application to enrolled
    const updatedAppRes = await client.query(
      `UPDATE admission_applications
       SET
         status = 'enrolled',
         admitted_student_id = $1,
         decision_date = NOW(),
         reviewed_by = $2,
         reviewed_at = NOW(),
         updated_at = NOW()
       WHERE tenant_id = $3 AND id = $4
       RETURNING *`,
      [student.id, req.user?.id ? Number(req.user.id) : null, tenantId, id]
    );

    await client.query("COMMIT");

    await logAudit(req, {
      action: "ENROLL",
      entityType: "student",
      entityId: student.id,
      details: {
        admissionNumber: student.admission_number,
        applicationId: id,
        studentName: `${student.first_name} ${student.last_name || ""}`.trim(),
        className: student.class_name,
      },
    });

    res.status(201).json({
      success: true,
      message: "Student successfully enrolled from application.",
      data: {
        student,
        application: updatedAppRes.rows[0],
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

// DELETE /api/admissions/applications/:id
// Delete application (or withdraw)
router.delete("/applications/:id", async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM admission_applications
       WHERE tenant_id = $1 AND id = $2 AND status != 'enrolled'
       RETURNING id, application_number`,
      [tenantId, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Application not found or cannot be deleted once enrolled.",
      });
    }

    await logAudit(req, {
      action: "DELETE",
      entityType: "admission_application",
      entityId: id,
      details: { deletedApp: result.rows[0] },
    });

    res.json({
      success: true,
      message: "Admission application removed.",
    });
  } catch (error) {
    next(error);
  }
});
// GET /api/admissions/:id/documents
router.get("/:id/documents", async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user.tenantId;

    if (!/^\d+$/.test(id) || Number(id) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid admission application ID"
      });
    }

    const application = await pool.query(
      `SELECT id, application_number
       FROM admission_applications
       WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    if (application.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Admission application not found"
      });
    }

    // Document storage is not implemented yet.
    return res.status(200).json({
      success: true,
      applicationId: Number(id),
      applicationNumber: application.rows[0].application_number,
      count: 0,
      data: [],
      message: "No admission documents are registered yet"
    });
  } catch (error) {
    console.error("Get admission documents error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve admission documents"
    });
  }
});
module.exports = router;
