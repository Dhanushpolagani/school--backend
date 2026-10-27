const express = require("express");
const path = require("path");
const fs = require("fs");
const pool = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const { logAudit } = require("../utils/auditLogger");
const {
  generateCertificatePdf,
  STORAGE_ROOT,
} = require("../services/pdfCertificateService");

const router = express.Router();

// Enforce authentication on all certificate routes
router.use(authenticateToken);

const SUPPORTED_CERTIFICATE_TYPES = [
  "bonafide",
  "study",
  "transfer",
  "character_conduct",
  "leaving",
  "merit",
  "sports",
  "completion",
  "custom",
];

function tenantIdOf(req) {
  return req.user?.tenantId;
}

function isPositiveInteger(value) {
  return /^[1-9]\d*$/.test(String(value));
}

function isAdmin(req) {
  const roles = req.user?.roles || [];
  return roles.includes("school_admin") || roles.includes("admin");
}

function isParent(req) {
  const roles = req.user?.roles || [];
  return roles.includes("parent");
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

/**
 * Escapes student or user input strings to prevent HTML/XSS injection.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Checks if a parent user is authorized to access a specific student.
 */
async function isParentLinkedToStudent(tenantId, userId, studentId) {
  const linkCheck = await pool.query(
    `SELECT 1
     FROM parents p
     LEFT JOIN parent_users pu ON pu.tenant_id = p.tenant_id AND pu.parent_id = p.id
     JOIN users u ON u.tenant_id = p.tenant_id AND (pu.user_id = u.id OR u.email = p.email)
     WHERE p.tenant_id = $1 AND u.id = $2 AND p.student_id = $3
     LIMIT 1`,
    [tenantId, userId, studentId]
  );
  return linkCheck.rowCount > 0;
}

/* ==========================================================================
   API 1: GET /api/certificates/templates
   Allowed role: school_admin
   ========================================================================== */
router.get("/templates", requireRole("school_admin", "admin"), async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const result = await pool.query(
      `SELECT
         id,
         tenant_id,
         name,
         certificate_type,
         description,
         template_content,
         placeholders,
         created_by,
         created_at,
         updated_at
       FROM certificate_templates
       WHERE tenant_id = $1
       ORDER BY id ASC`,
      [tenantId]
    );

    return res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   API 2: POST /api/certificates/templates
   Allowed role: school_admin
   ========================================================================== */
router.post("/templates", requireRole("school_admin", "admin"), async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const { name, certificateType, description, templateContent, placeholders } = req.body;

    // Validate required fields
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Validation error: 'name' is required and must be a non-empty string.",
      });
    }

    if (name.trim().length > 150) {
      return res.status(400).json({
        success: false,
        message: "Validation error: 'name' must not exceed 150 characters.",
      });
    }

    if (!certificateType || typeof certificateType !== "string" || !certificateType.trim()) {
      return res.status(400).json({
        success: false,
        message: "Validation error: 'certificateType' is required and must be a non-empty string.",
      });
    }

    const normalizedType = certificateType.trim().toLowerCase();
    if (!SUPPORTED_CERTIFICATE_TYPES.includes(normalizedType)) {
      return res.status(400).json({
        success: false,
        message: `Validation error: Invalid certificateType '${certificateType}'. Supported types are: ${SUPPORTED_CERTIFICATE_TYPES.join(", ")}.`,
      });
    }

    if (!templateContent || typeof templateContent !== "string" || !templateContent.trim()) {
      return res.status(400).json({
        success: false,
        message: "Validation error: 'templateContent' is required and must be a non-empty string.",
      });
    }

    // Determine placeholders: if provided, validate; else extract from templateContent
    let placeholdersList = [];
    if (Array.isArray(placeholders)) {
      placeholdersList = placeholders.map((p) => {
        const cleaned = String(p).replace(/^\{\{|\}\}$/g, "").trim();
        return cleaned;
      }).filter(Boolean);
    } else {
      const matches = templateContent.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
      placeholdersList = [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "").trim()))];
    }

    const cleanDescription = description && typeof description === "string" ? description.trim() : null;

    const result = await pool.query(
      `INSERT INTO certificate_templates (
         tenant_id,
         name,
         certificate_type,
         description,
         template_content,
         placeholders,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        tenantId,
        name.trim(),
        normalizedType,
        cleanDescription,
        templateContent.trim(),
        JSON.stringify(placeholdersList),
        req.user.id || null,
      ]
    );

    const createdTemplate = result.rows[0];

    await logAudit(req, {
      action: "CREATE_CERTIFICATE_TEMPLATE",
      entityType: "certificate_template",
      entityId: createdTemplate.id,
      details: {
        name: createdTemplate.name,
        certificateType: createdTemplate.certificate_type,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Certificate template created successfully",
      data: createdTemplate,
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   API 3: POST /api/certificates/generate
   Allowed role: school_admin
   ========================================================================== */
router.post("/generate", requireRole("school_admin", "admin"), async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  try {
    const { studentId, templateId, issueDate, academicYear } = req.body;

    // Validate studentId and templateId
    if (!isPositiveInteger(studentId) || !isPositiveInteger(templateId)) {
      return res.status(400).json({
        success: false,
        message: "Validation error: 'studentId' and 'templateId' must be positive integers.",
      });
    }

    // Validate issueDate if provided
    let cleanIssueDate = new Date().toISOString().split("T")[0];
    if (issueDate) {
      if (typeof issueDate !== "string" || isNaN(Date.parse(issueDate))) {
        return res.status(400).json({
          success: false,
          message: "Validation error: 'issueDate' must be a valid date (e.g. YYYY-MM-DD).",
        });
      }
      cleanIssueDate = new Date(issueDate).toISOString().split("T")[0];
    }

    const cleanAcademicYear = academicYear && typeof academicYear === "string" && academicYear.trim()
      ? academicYear.trim()
      : `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;

    // 1. Fetch student from database ensuring tenant isolation
    const studentRes = await pool.query(
      `SELECT
         id,
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
       FROM students
       WHERE id = $1 AND tenant_id = $2`,
      [studentId, tenantId]
    );

    if (studentRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found in your school records.",
      });
    }

    const student = studentRes.rows[0];

    // 2. Fetch certificate template ensuring tenant isolation
    const templateRes = await pool.query(
      `SELECT
         id,
         name,
         certificate_type,
         template_content,
         placeholders
       FROM certificate_templates
       WHERE id = $1 AND tenant_id = $2`,
      [templateId, tenantId]
    );

    if (templateRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Certificate template not found.",
      });
    }

    const template = templateRes.rows[0];

    // 3. Fetch tenant details (school name, address)
    const tenantRes = await pool.query(
      `SELECT name, address, phone, email FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const tenant = tenantRes.rows[0] || {};
    const schoolName = tenant.name || "School ERP Academy";
    const schoolAddress = tenant.address || "";

    // 4. Fetch parent details if available
    const parentRes = await pool.query(
      `SELECT full_name, relationship FROM parents WHERE tenant_id = $1 AND student_id = $2 ORDER BY id ASC LIMIT 1`,
      [tenantId, studentId]
    );
    const parent = parentRes.rows[0] || null;

    // 5. Generate certificate number
    const certNumber = `CERT-${tenantId}-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;

    const studentFullName = `${student.first_name || ""} ${student.last_name || ""}`.trim();
    const formattedDob = student.date_of_birth ? String(student.date_of_birth).split("T")[0] : "N/A";

    // 6. Build placeholder dictionary with HTML-escaped values
    const replacements = {
      studentName: escapeHtml(studentFullName),
      admissionNumber: escapeHtml(student.admission_number || "N/A"),
      className: escapeHtml(student.class_name || "N/A"),
      sectionName: escapeHtml(student.section || "A"),
      rollNumber: escapeHtml(student.roll_number || "N/A"),
      academicYear: escapeHtml(cleanAcademicYear),
      issueDate: escapeHtml(cleanIssueDate),
      schoolName: escapeHtml(schoolName),
      schoolAddress: escapeHtml(schoolAddress),
      dateOfBirth: escapeHtml(formattedDob),
      gender: escapeHtml(student.gender || "N/A"),
      certificateNumber: escapeHtml(certNumber),
      parentName: escapeHtml(parent?.full_name || "Parent/Guardian"),
      fatherName: escapeHtml(parent?.full_name || "Father"),
      motherName: escapeHtml("Mother"),
    };

    // Replace all known placeholders: {{key}}
    let renderedHtml = template.template_content;
    for (const [key, val] of Object.entries(replacements)) {
      const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");
      renderedHtml = renderedHtml.replace(regex, val);
    }

    // Clean any remaining unsupported placeholders safely
    renderedHtml = renderedHtml.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, "");

    // 7. Generate PDF on local disk
    let pdfResult;
    try {
      pdfResult = await generateCertificatePdf({
        tenantId,
        certificateNumber: certNumber,
        templateName: template.name,
        certificateType: template.certificate_type,
        schoolName,
        schoolAddress,
        studentName: studentFullName,
        admissionNumber: student.admission_number,
        className: student.class_name,
        renderedContent: renderedHtml,
        issueDate: cleanIssueDate,
        academicYear: cleanAcademicYear,
      });
    } catch (pdfErr) {
      console.error("PDF generation failed:", pdfErr);
      return res.status(500).json({
        success: false,
        message: "Failed to generate PDF certificate document.",
      });
    }

    // 8. Save certificate record in PostgreSQL
    const certInsert = await pool.query(
      `INSERT INTO student_certificates (
         tenant_id,
         student_id,
         template_id,
         certificate_type,
         certificate_number,
         issue_date,
         academic_year,
         file_storage_key,
         file_name,
         generation_status,
         generated_by,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'completed', $10, $11)
       RETURNING *`,
      [
        tenantId,
        studentId,
        templateId,
        template.certificate_type,
        certNumber,
        cleanIssueDate,
        cleanAcademicYear,
        pdfResult.storageKey,
        pdfResult.fileName,
        req.user.id || null,
        JSON.stringify({
          studentName: studentFullName,
          admissionNumber: student.admission_number,
          className: student.class_name,
          section: student.section,
          schoolName,
        }),
      ]
    );

    const certRecord = certInsert.rows[0];

    await logAudit(req, {
      action: "GENERATE_CERTIFICATE",
      entityType: "student_certificate",
      entityId: certRecord.id,
      details: {
        studentId,
        templateId,
        certificateNumber: certNumber,
        certificateType: template.certificate_type,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Certificate generated successfully",
      data: {
        id: certRecord.id,
        studentId: certRecord.student_id,
        templateId: certRecord.template_id,
        certificateType: certRecord.certificate_type,
        certificateNumber: certRecord.certificate_number,
        issueDate: certRecord.issue_date,
        academicYear: certRecord.academic_year,
        fileName: certRecord.file_name,
        downloadUrl: `/api/certificates/download/${certRecord.id}`,
      },
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   API 4: GET /api/certificates/:studentId
   Allowed roles: school_admin, parent
   ========================================================================== */
router.get("/:studentId", requireRole("school_admin", "admin", "parent"), async (req, res, next) => {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { studentId } = req.params;

  if (!isPositiveInteger(studentId)) {
    return res.status(400).json({
      success: false,
      message: "Validation error: 'studentId' must be a positive integer.",
    });
  }

  try {
    // 1. Verify student exists within this tenant
    const studentCheck = await pool.query(
      `SELECT id, first_name, last_name, admission_number, class_name
       FROM students
       WHERE id = $1 AND tenant_id = $2`,
      [studentId, tenantId]
    );

    if (studentCheck.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    // 2. Authorization check: If caller is a parent, verify student is linked to this parent
    if (isParent(req) && !isAdmin(req)) {
      const isLinked = await isParentLinkedToStudent(tenantId, req.user.id, studentId);
      if (!isLinked) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only view certificates for your linked children.",
        });
      }
    }

    // 3. Retrieve student's certificates
    const certsRes = await pool.query(
      `SELECT
         sc.id,
         sc.student_id,
         sc.template_id,
         sc.certificate_type,
         sc.certificate_number,
         sc.issue_date,
         sc.academic_year,
         sc.file_name,
         sc.generation_status,
         sc.created_at,
         ct.name AS template_name
       FROM student_certificates sc
       JOIN certificate_templates ct ON ct.id = sc.template_id AND ct.tenant_id = sc.tenant_id
       WHERE sc.tenant_id = $1 AND sc.student_id = $2
       ORDER BY sc.created_at DESC`,
      [tenantId, studentId]
    );

    const formattedCerts = certsRes.rows.map((cert) => ({
      ...cert,
      downloadUrl: `/api/certificates/download/${cert.id}`,
    }));

    return res.json({
      success: true,
      count: formattedCerts.length,
      data: formattedCerts,
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   DOWNLOAD / STREAM CERTIFICATE PDF
   Allowed roles: school_admin, parent
   ========================================================================== */
async function handleDownload(req, res, next) {
  const tenantId = requireTenant(req, res);
  if (!tenantId) return;

  const { id } = req.params;

  if (!isPositiveInteger(id)) {
    return res.status(400).json({
      success: false,
      message: "Validation error: 'id' must be a positive integer.",
    });
  }

  try {
    const certRes = await pool.query(
      `SELECT
         sc.id,
         sc.tenant_id,
         sc.student_id,
         sc.file_storage_key,
         sc.file_name,
         sc.certificate_number
       FROM student_certificates sc
       WHERE sc.id = $1 AND sc.tenant_id = $2`,
      [id, tenantId]
    );

    if (certRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Certificate record not found.",
      });
    }

    const cert = certRes.rows[0];

    // If caller is a parent, verify parent owns student
    if (isParent(req) && !isAdmin(req)) {
      const isLinked = await isParentLinkedToStudent(tenantId, req.user.id, cert.student_id);
      if (!isLinked) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only download certificates for your linked children.",
        });
      }
    }

    // Resolve file path safely and prevent directory traversal
    const safePath = path.resolve(STORAGE_ROOT, cert.file_storage_key);
    if (!safePath.startsWith(STORAGE_ROOT)) {
      return res.status(400).json({
        success: false,
        message: "Invalid file storage reference.",
      });
    }

    if (!fs.existsSync(safePath)) {
      return res.status(404).json({
        success: false,
        message: "Certificate PDF file not found on server storage.",
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${cert.file_name}"`);

    const readStream = fs.createReadStream(safePath);
    readStream.on("error", (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: "Error reading certificate file." });
      }
    });

    readStream.pipe(res);
  } catch (error) {
    next(error);
  }
}

router.get("/download/:id", requireRole("school_admin", "admin", "parent"), handleDownload);
router.get("/:id/download", requireRole("school_admin", "admin", "parent"), handleDownload);

module.exports = router;
