const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const STORAGE_ROOT = path.resolve(__dirname, "../../storage/certificates");

/**
 * Ensures the target directory exists.
 */
function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Strips HTML tags and cleans up extra whitespace for plain text PDF rendering.
 */
function stripHtmlTags(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*[\/]?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}

/**
 * Draws a professional certificate border and decorative seal.
 */
function drawCertificateFrame(doc, width, height) {
  const margin = 28;
  const innerMargin = 36;

  // Outer primary border (Deep Navy)
  doc.rect(margin, margin, width - margin * 2, height - margin * 2)
    .lineWidth(4)
    .stroke("#1E3A8A");

  // Inner accent border (Gold)
  doc.rect(innerMargin, innerMargin, width - innerMargin * 2, height - innerMargin * 2)
    .lineWidth(1.5)
    .stroke("#D97706");

  // Corner decorative flourishes
  const corners = [
    [innerMargin, innerMargin],
    [width - innerMargin, innerMargin],
    [innerMargin, height - innerMargin],
    [width - innerMargin, height - innerMargin],
  ];

  corners.forEach(([cx, cy]) => {
    doc.circle(cx, cy, 4).fill("#D97706");
  });

  // Top header ornament
  doc.moveTo(width / 2 - 80, innerMargin + 10)
    .lineTo(width / 2 + 80, innerMargin + 10)
    .lineWidth(0.8)
    .stroke("#D97706");
}

/**
 * Draws an official seal emblem in the bottom center of the certificate.
 */
function drawOfficialSeal(doc, centerX, centerY) {
  doc.save();

  // Seal outer glow / starburst effect
  const numRays = 18;
  const outerRadius = 34;
  const innerRadius = 30;

  for (let i = 0; i < numRays; i++) {
    const angle = (i * Math.PI) / (numRays / 2);
    const x1 = centerX + Math.cos(angle) * innerRadius;
    const y1 = centerY + Math.sin(angle) * innerRadius;
    const x2 = centerX + Math.cos(angle) * outerRadius;
    const y2 = centerY + Math.sin(angle) * outerRadius;

    doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(1.5).stroke("#D97706");
  }

  // Outer circle
  doc.circle(centerX, centerY, 28)
    .lineWidth(2)
    .fillAndStroke("#FEF3C7", "#B45309");

  // Inner circle
  doc.circle(centerX, centerY, 23)
    .lineWidth(1)
    .stroke("#D97706");

  // Seal text
  doc.font("Helvetica-Bold")
    .fontSize(6)
    .fillColor("#92400E")
    .text("OFFICIAL SEAL", centerX - 25, centerY - 6, {
      width: 50,
      align: "center",
    })
    .text("VERIFIED", centerX - 25, centerY + 3, {
      width: 50,
      align: "center",
    });

  // Ribbon tails below seal
  doc.polygon(
    [centerX - 16, centerY + 24],
    [centerX - 24, centerY + 46],
    [centerX - 16, centerY + 40],
    [centerX - 8, centerY + 46],
    [centerX - 8, centerY + 26]
  ).fill("#B45309");

  doc.polygon(
    [centerX + 8, centerY + 26],
    [centerX + 8, centerY + 46],
    [centerX + 16, centerY + 40],
    [centerX + 24, centerY + 46],
    [centerX + 16, centerY + 24]
  ).fill("#92400E");

  doc.restore();
}

/**
 * Generates a certificate PDF and saves it to local disk storage.
 *
 * @param {Object} params
 * @param {number|string} params.tenantId
 * @param {string} params.certificateNumber
 * @param {string} params.templateName
 * @param {string} params.certificateType
 * @param {string} params.schoolName
 * @param {string} params.schoolAddress
 * @param {string} params.studentName
 * @param {string} params.admissionNumber
 * @param {string} params.className
 * @param {string} params.renderedContent
 * @param {string} params.issueDate
 * @param {string} params.academicYear
 * @returns {Promise<{ filePath: string, storageKey: string, fileName: string }>}
 */
function generateCertificatePdf({
  tenantId,
  certificateNumber,
  templateName,
  certificateType,
  schoolName,
  schoolAddress,
  studentName,
  admissionNumber,
  className,
  renderedContent,
  issueDate,
  academicYear,
}) {
  return new Promise((resolve, reject) => {
    try {
      const tenantDir = path.join(STORAGE_ROOT, `tenant_${tenantId}`);
      ensureDirExists(tenantDir);

      const timestamp = Date.now();
      const sanitizedStudent = (studentName || "student").replace(/[^a-zA-Z0-9]/g, "_");
      const sanitizedType = (certificateType || "certificate").replace(/[^a-zA-Z0-9]/g, "_");
      const fileName = `${sanitizedStudent}_${sanitizedType}_${timestamp}.pdf`;
      const relativeStorageKey = `tenant_${tenantId}/${fileName}`;
      const fullFilePath = path.join(tenantDir, fileName);

      // Landscape A4 dimensions: 841.89 x 595.28
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
        info: {
          Title: `${templateName} - ${studentName}`,
          Author: schoolName,
          Subject: `${certificateType} Certificate`,
          Keywords: "School ERP Certificate",
          CreationDate: new Date(),
        },
      });

      const writeStream = fs.createWriteStream(fullFilePath);

      writeStream.on("error", (err) => {
        reject(err);
      });

      writeStream.on("finish", () => {
        resolve({
          filePath: fullFilePath,
          storageKey: relativeStorageKey,
          fileName,
        });
      });

      doc.pipe(writeStream);

      const pageWidth = 841.89;
      const pageHeight = 595.28;

      // 1. Draw decorative outer and inner frames
      drawCertificateFrame(doc, pageWidth, pageHeight);

      // 2. School Header
      const headerTop = 55;
      doc.font("Helvetica-Bold")
        .fontSize(22)
        .fillColor("#1E3A8A")
        .text((schoolName || "SCHOOL ERP ACADEMY").toUpperCase(), 50, headerTop, {
          width: pageWidth - 100,
          align: "center",
        });

      if (schoolAddress) {
        doc.font("Helvetica")
          .fontSize(9)
          .fillColor("#64748B")
          .text(schoolAddress, 50, headerTop + 27, {
            width: pageWidth - 100,
            align: "center",
          });
      }

      // Divider line under school header
      const dividerY = headerTop + (schoolAddress ? 44 : 32);
      doc.moveTo(180, dividerY)
        .lineTo(pageWidth - 180, dividerY)
        .lineWidth(1)
        .stroke("#CBD5E1");

      // 3. Certificate Title
      const titleY = dividerY + 14;
      const displayTitle = (templateName || `${certificateType} Certificate`).toUpperCase();
      doc.font("Helvetica-Bold")
        .fontSize(19)
        .fillColor("#B45309")
        .text(displayTitle, 50, titleY, {
          width: pageWidth - 100,
          align: "center",
          characterSpacing: 1.5,
        });

      // 4. Metadata Bar (Certificate No. on Left, Issue Date on Right)
      const metaY = titleY + 30;
      doc.font("Helvetica")
        .fontSize(9)
        .fillColor("#475569")
        .text(`Certificate No: ${certificateNumber}`, 65, metaY, {
          width: 300,
          align: "left",
        });

      const formattedDate = issueDate ? String(issueDate).split("T")[0] : new Date().toISOString().split("T")[0];
      doc.font("Helvetica")
        .fontSize(9)
        .fillColor("#475569")
        .text(`Date of Issue: ${formattedDate}`, pageWidth - 365, metaY, {
          width: 300,
          align: "right",
        });

      // 5. Presentation line
      const presentY = metaY + 26;
      doc.font("Helvetica-Oblique")
        .fontSize(12)
        .fillColor("#475569")
        .text("This is to certify that", 50, presentY, {
          width: pageWidth - 100,
          align: "center",
        });

      // 6. Student Name (Emphasized)
      const studentNameY = presentY + 20;
      doc.font("Helvetica-Bold")
        .fontSize(22)
        .fillColor("#0F172A")
        .text(studentName || "Student Name", 50, studentNameY, {
          width: pageWidth - 100,
          align: "center",
        });

      // Subtle underline under student name
      const nameWidth = Math.min(360, (studentName?.length || 10) * 14);
      doc.moveTo((pageWidth - nameWidth) / 2, studentNameY + 26)
        .lineTo((pageWidth + nameWidth) / 2, studentNameY + 26)
        .lineWidth(0.8)
        .stroke("#D97706");

      // 7. Certificate Body Paragraph(s)
      const plainContent = stripHtmlTags(renderedContent);
      const bodyY = studentNameY + 38;

      doc.font("Helvetica")
        .fontSize(13)
        .fillColor("#334155")
        .text(plainContent, 90, bodyY, {
          width: pageWidth - 180,
          align: "center",
          lineGap: 6,
        });

      // 8. Signatures & Seal Section at the bottom
      const footerY = pageHeight - 95;

      // Left Signature: Prepared / Verified By
      doc.moveTo(80, footerY)
        .lineTo(240, footerY)
        .lineWidth(1)
        .stroke("#475569");

      doc.font("Helvetica")
        .fontSize(10)
        .fillColor("#475569")
        .text("Prepared / Verified By", 80, footerY + 6, {
          width: 160,
          align: "center",
        });

      // Center Official Seal
      drawOfficialSeal(doc, pageWidth / 2, footerY - 5);

      // Right Signature: Principal / Head of Institution
      doc.moveTo(pageWidth - 240, footerY)
        .lineTo(pageWidth - 80, footerY)
        .lineWidth(1)
        .stroke("#475569");

      doc.font("Helvetica-Bold")
        .fontSize(10)
        .fillColor("#1E3A8A")
        .text("Principal / Head of Institution", pageWidth - 240, footerY + 6, {
          width: 160,
          align: "center",
        });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  generateCertificatePdf,
  stripHtmlTags,
  STORAGE_ROOT,
};
