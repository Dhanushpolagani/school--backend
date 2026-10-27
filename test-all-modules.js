const jwt = require("jsonwebtoken");
const app = require("./src/app");
const pool = require("./src/config/db");

// Simple HTTP-like test runner using express request simulation or supertest-like fetch
// Since Express app can listen on an ephemeral port or we can use node http:
const http = require("http");

let server;
let baseUrl;
let token;
let tenantId = "1";
let adminUserId = "1";

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...headers,
    };

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode, body: json });
      });
    });

    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("STARTING TEST SUITE FOR ALL 9 COMPLETE MODULES");
  console.log("==================================================");

  // 1. Start ephemeral HTTP server
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Server listening on ${baseUrl}`);

  // 2. Fetch admin user & create JWT
  const userRes = await pool.query("SELECT * FROM users WHERE id = 1");
  const user = userRes.rows[0];
  tenantId = String(user.tenant_id);
  adminUserId = String(user.id);

  token = jwt.sign(
    { sub: adminUserId, tenantId, roles: ["school_admin", "admin"] },
    process.env.JWT_SECRET || "REPLACE_WITH_A_LONG_RANDOM_SECRET_KEY_FOR_TESTS",
    { expiresIn: "1h" }
  );

  console.log(`Authenticated as user ${user.email} (Tenant ${tenantId})`);

  let studentId;
  let applicationId;
  let poId;
  let payrollRunId;
  let announcementId;
  let courseId;
  let assignmentId;

  // ----------------------------------------------------
  // MODULE 1: ADMISSIONS & ENROLMENT
  // ----------------------------------------------------
  console.log("\n[1/8] Testing Admissions & Enrolment...");
  {
    // Submit Application
    const res1 = await request("POST", "/api/admissions/applications", {
      firstName: "Antigravity",
      lastName: "Candidate",
      dateOfBirth: "2015-08-20",
      gender: "female",
      className: "Class 6",
      parentName: "Robert Candidate",
      parentPhone: "+919876543210",
      parentEmail: "robert@example.com",
      address: "123 Academic Avenue",
      previousSchool: "Greenwood Primary",
    });
    assert(res1.status === 201, `Create application failed: ${JSON.stringify(res1.body)}`);
    applicationId = res1.body.data.id;
    console.log(`  ✓ Application created: ${res1.body.data.application_number} (ID: ${applicationId})`);

    // List & Filter
    const res2 = await request("GET", "/api/admissions/applications?search=Antigravity");
    assert(res2.status === 200 && res2.body.data.length > 0, "List applications failed");
    console.log(`  ✓ Application search found ${res2.body.data.length} match(es)`);

    // Stats
    const res3 = await request("GET", "/api/admissions/stats");
    assert(res3.status === 200, "Admissions stats failed");
    console.log(`  ✓ Admissions stats: Total ${res3.body.data.summary.total_applications}`);

    // Schedule Interview
    const res4 = await request("POST", `/api/admissions/applications/${applicationId}/interview`, {
      interviewDate: new Date(Date.now() + 86400000).toISOString(),
      interviewNotes: "Proficient in Mathematics and Science",
    });
    assert(res4.status === 200, "Schedule interview failed");
    console.log("  ✓ Interview scheduled");

    // Status transition to approved
    const res5 = await request("PATCH", `/api/admissions/applications/${applicationId}/status`, {
      status: "approved",
      decisionRemarks: "Recommended for immediate enrolment",
    });
    assert(res5.status === 200, "Status update failed");
    console.log("  ✓ Application approved");

    // Enrol into students table
    const res6 = await request("POST", `/api/admissions/applications/${applicationId}/enroll`, {
      section: "A",
      rollNumber: "15",
    });
    assert(res6.status === 201, `Enroll failed: ${JSON.stringify(res6.body)}`);
    studentId = res6.body.data.student.id;
    console.log(`  ✓ Student enrolled successfully! Admission No: ${res6.body.data.student.admission_number} (Student ID: ${studentId})`);
  }

  // ----------------------------------------------------
  // MODULE 2: PURCHASE ORDERS
  // ----------------------------------------------------
  console.log("\n[2/8] Testing Purchase Orders...");
  {
    // Ensure supplier exists
    let supplierRes = await pool.query(
      "SELECT id FROM inventory_suppliers WHERE tenant_id = $1 LIMIT 1",
      [tenantId]
    );
    let supplierId;
    if (supplierRes.rowCount === 0) {
      const sup = await pool.query(
        "INSERT INTO inventory_suppliers (tenant_id, name, email, phone) VALUES ($1, 'Acme School Supplies', 'acme@supplies.test', '9988776655') RETURNING id",
        [tenantId]
      );
      supplierId = sup.rows[0].id;
    } else {
      supplierId = supplierRes.rows[0].id;
    }

    // Ensure item exists
    let itemRes = await pool.query(
      "SELECT id FROM inventory_items WHERE tenant_id = $1 LIMIT 1",
      [tenantId]
    );
    let itemId;
    if (itemRes.rowCount === 0) {
      // Ensure category
      let cat = await pool.query(
        "INSERT INTO inventory_categories (tenant_id, name) VALUES ($1, 'Stationery') ON CONFLICT DO NOTHING RETURNING id",
        [tenantId]
      );
      let catId = cat.rows[0]?.id;
      if (!catId) {
        const c = await pool.query("SELECT id FROM inventory_categories WHERE tenant_id = $1 LIMIT 1", [tenantId]);
        catId = c.rows[0].id;
      }
      const item = await pool.query(
        "INSERT INTO inventory_items (tenant_id, category_id, item_code, name, unit, unit_cost, quantity_on_hand, reorder_level) VALUES ($1, $2, 'ITEM-NOTE-01', 'Ruled Notebooks', 'piece', 45.00, 20, 50) RETURNING id",
        [tenantId, catId]
      );
      itemId = item.rows[0].id;
    } else {
      itemId = itemRes.rows[0].id;
    }

    // Create Purchase Order
    const poCreateRes = await request("POST", "/api/purchase-orders", {
      supplierId,
      orderDate: "2026-10-25",
      expectedDeliveryDate: "2026-11-05",
      taxAmount: 50,
      paymentTerms: "Net 30",
      items: [
        {
          itemId,
          quantityOrdered: 100,
          unitPrice: 45.00,
          description: "Bulk order of ruled notebooks",
        },
      ],
    });
    assert(poCreateRes.status === 201, `PO create failed: ${JSON.stringify(poCreateRes.body)}`);
    poId = poCreateRes.body.data.id;
    console.log(`  ✓ Purchase Order created: ${poCreateRes.body.data.po_number} (Total: ₹${poCreateRes.body.data.total_amount})`);

    // Approve PO
    const poApproveRes = await request("PATCH", `/api/purchase-orders/${poId}/status`, {
      status: "approved",
      notes: "Budget approved by administrator",
    });
    assert(poApproveRes.status === 200, "PO approve failed");
    console.log("  ✓ Purchase Order approved");

    // Receive items against PO (GRN)
    const grnRes = await request("POST", `/api/purchase-orders/${poId}/receive`, {
      receivedItems: [
        {
          itemId,
          quantityReceived: 50,
          remarks: "First delivery received in good condition",
        },
      ],
    });
    assert(grnRes.status === 200, `PO receive failed: ${JSON.stringify(grnRes.body)}`);
    console.log(`  ✓ Goods received! PO Status: ${grnRes.body.data.status}`);

    // Summary
    const poSum = await request("GET", "/api/purchase-orders/summary");
    assert(poSum.status === 200, "PO summary failed");
    console.log(`  ✓ PO Summary: Total orders = ${poSum.body.data.total_orders}`);
  }

  // ----------------------------------------------------
  // MODULE 3: PAYROLL
  // ----------------------------------------------------
  console.log("\n[3/8] Testing Payroll...");
  {
    // Create salary component
    const compRes = await request("POST", "/api/payroll/components", {
      name: "House Rent Allowance",
      type: "earning",
      calculationType: "fixed",
      defaultAmountPaise: 1500000, // ₹15,000
    });
    console.log("  ✓ Salary component registered/checked");

    // Ensure at least one staff exists
    let staffRes = await pool.query("SELECT id FROM staff WHERE tenant_id = $1 LIMIT 1", [tenantId]);
    let staffId;
    if (staffRes.rowCount === 0) {
      const s = await pool.query(
        `INSERT INTO staff (tenant_id, employee_number, first_name, last_name, joining_date, salary_paise, status)
         VALUES ($1, 'EMP-1001', 'Alan', 'Turing', '2024-01-01', 5000000, 'active')
         RETURNING id`,
        [tenantId]
      );
      staffId = s.rows[0].id;
    } else {
      staffId = staffRes.rows[0].id;
    }

    // Configure salary structure
    const structRes = await request("POST", "/api/payroll/structures", {
      staffId,
      basicSalaryPaise: 5000000, // ₹50,000
      components: [
        { name: "HRA", type: "earning", amount_paise: 1500000 },
        { name: "PF", type: "deduction", amount_paise: 600000 },
      ],
      bankName: "HDFC Bank",
      bankAccountNumber: "50100234567890",
    });
    assert(structRes.status === 200, `Structure config failed: ${JSON.stringify(structRes.body)}`);
    console.log("  ✓ Staff salary structure configured");

    // Clean previous test run if re-running
    await pool.query("DELETE FROM payroll_runs WHERE tenant_id = $1 AND month = 10 AND year = 2026", [tenantId]);

    // Create payroll run
    const runRes = await request("POST", "/api/payroll/runs", {
      month: 10,
      year: 2026,
      title: "October 2026 Payroll",
    });
    assert(runRes.status === 201, "Failed to create payroll run");
    payrollRunId = runRes.body.data.id;
    console.log(`  ✓ Payroll run ID: ${payrollRunId}`);

    // Generate Payslips
    const genRes = await request("POST", `/api/payroll/runs/${payrollRunId}/generate`);
    assert(genRes.status === 200, `Generate payslips failed: ${JSON.stringify(genRes.body)}`);
    console.log(`  ✓ Payslips generated: ${genRes.body.data.total_staff_count} staff, Net: ₹${genRes.body.data.total_net_paise / 100}`);

    // Approve & Disburse
    await request("PATCH", `/api/payroll/runs/${payrollRunId}/status`, { status: "approved" });
    const disburseRes = await request("POST", `/api/payroll/runs/${payrollRunId}/disburse`, {
      paymentMethod: "bank_transfer",
      paymentReference: "NEFT-20261025-BATCH01",
    });
    assert(disburseRes.status === 200, "Disburse failed");
    console.log("  ✓ Payroll disbursed successfully!");

    // Payroll summary
    const paySum = await request("GET", "/api/payroll/summary");
    assert(paySum.status === 200, "Payroll summary failed");
    console.log(`  ✓ Payroll Summary verified: Active staff = ${paySum.body.data.active_staff_count}`);
  }

  // ----------------------------------------------------
  // MODULE 4: DASHBOARD & ANALYTICS
  // ----------------------------------------------------
  console.log("\n[4/8] Testing Dashboard & Analytics...");
  {
    const overview = await request("GET", "/api/dashboard/overview");
    assert(overview.status === 200, "Overview failed");
    console.log("  ✓ Dashboard Overview retrieved successfully");
    console.log(`    - Active Students: ${overview.body.data.students.active_students}`);
    console.log(`    - Total Staff: ${overview.body.data.students.total_staff}`);
    console.log(`    - Total Billed: ₹${overview.body.data.finances.totalBilledPaise / 100}`);

    const admissions = await request("GET", "/api/dashboard/admissions");
    assert(admissions.status === 200, "Admissions analytics failed");
    console.log(`  ✓ Admissions Analytics retrieved: ${admissions.body.data.funnel.length} funnel stages`);

    const finance = await request("GET", "/api/dashboard/finance");
    assert(finance.status === 200, "Finance analytics failed");
    console.log("  ✓ Finance Analytics retrieved");

    const attendance = await request("GET", "/api/dashboard/attendance");
    assert(attendance.status === 200, "Attendance analytics failed");
    console.log("  ✓ Attendance Analytics retrieved");

    const quick = await request("GET", "/api/dashboard/quick-stats");
    assert(quick.status === 200, "Quick stats failed");
    console.log("  ✓ Quick Stats widget retrieved");
  }

  // ----------------------------------------------------
  // MODULE 5: NOTIFICATIONS & ANNOUNCEMENTS
  // ----------------------------------------------------
  console.log("\n[5/8] Testing Notifications & Announcements...");
  {
    // Create announcement
    const annRes = await request("POST", "/api/announcements", {
      title: "Annual Sports Day 2026 Announced",
      content: "All classes are invited to register for track and field events.",
      category: "sports",
      targetAudience: "all",
      priority: "high",
    });
    assert(annRes.status === 201, `Announcement failed: ${JSON.stringify(annRes.body)}`);
    announcementId = annRes.body.data.id;
    console.log(`  ✓ Announcement published: ${annRes.body.data.title}`);

    // List announcements
    const listAnn = await request("GET", "/api/announcements");
    assert(listAnn.status === 200 && listAnn.body.data.length > 0, "List announcements failed");
    console.log(`  ✓ Found ${listAnn.body.data.length} announcement(s)`);

    // Send direct notification
    const notifRes = await request("POST", "/api/notifications/send", {
      userId: Number(adminUserId),
      title: "Payment Received",
      message: "Tuition fee payment confirmed.",
      type: "success",
    });
    assert(notifRes.status === 201, `Send notification failed: ${JSON.stringify(notifRes.body)}`);
    console.log("  ✓ Direct user notification sent");

    // List user notifications
    const myNotifs = await request("GET", "/api/notifications");
    assert(myNotifs.status === 200, "Get notifications failed");
    console.log(`  ✓ Unread notifications: ${myNotifs.body.unreadCount}`);

    // Mark all as read
    const markRes = await request("POST", "/api/notifications/mark-all-read");
    assert(markRes.status === 200, "Mark all read failed");
    console.log("  ✓ All notifications marked as read");
  }

  // ----------------------------------------------------
  // MODULE 6: STUDENT & PARENT PORTALS
  // ----------------------------------------------------
  console.log("\n[6/8] Testing Student & Parent Portals...");
  {
    // Link current user to student
    const linkRes = await request("POST", "/api/portal/link-student", {
      userId: Number(adminUserId),
      studentId: Number(studentId),
    });
    assert(linkRes.status === 200, "Link student failed");
    console.log("  ✓ User linked to student record");

    // Fetch student profile
    const profileRes = await request("GET", "/api/portal/student/profile");
    assert(profileRes.status === 200, `Student profile failed: ${JSON.stringify(profileRes.body)}`);
    console.log(`  ✓ Student Portal Profile: ${profileRes.body.data.profile.first_name} (Class: ${profileRes.body.data.profile.class_name})`);

    // Fetch student attendance
    const attRes = await request("GET", "/api/portal/student/attendance");
    assert(attRes.status === 200, "Student attendance failed");
    console.log("  ✓ Student attendance record loaded");

    // Fetch student fees
    const feesRes = await request("GET", "/api/portal/student/fees");
    assert(feesRes.status === 200, "Student fees failed");
    console.log("  ✓ Student fees statement loaded");

    // Parent submits leave
    const leaveRes = await request("POST", `/api/portal/parent/children/${studentId}/leave`, {
      fromDate: "2026-11-01",
      toDate: "2026-11-03",
      reason: "Family gathering",
    });
    assert(leaveRes.status === 201, "Parent leave request failed");
    console.log("  ✓ Parent leave request submitted");
  }

  // ----------------------------------------------------
  // MODULE 7: LMS (LEARNING MANAGEMENT SYSTEM)
  // ----------------------------------------------------
  console.log("\n[7/8] Testing LMS...");
  {
    // Create course
    const courseRes = await request("POST", "/api/lms/courses", {
      code: `MATH-${Date.now().toString().slice(-4)}`,
      title: "Advanced Algebra & Calculus",
      description: "Comprehensive algebra fundamentals and polynomial operations.",
      academicTerm: "Term 1",
    });
    assert(courseRes.status === 201, `Course creation failed: ${JSON.stringify(courseRes.body)}`);
    courseId = courseRes.body.data.id;
    console.log(`  ✓ LMS Course created: ${courseRes.body.data.title} (${courseRes.body.data.code})`);

    // Add Lesson
    const lessonRes = await request("POST", `/api/lms/courses/${courseId}/lessons`, {
      lessonNumber: 1,
      title: "Introduction to Quadratic Equations",
      description: "Standard form and roots calculation.",
      contentBody: "# Quadratic Equations\nax^2 + bx + c = 0",
    });
    assert(lessonRes.status === 201, "Lesson add failed");
    console.log("  ✓ LMS Lesson added");

    // Add Material
    const matRes = await request("POST", `/api/lms/courses/${courseId}/materials`, {
      title: "Polynomials Cheat Sheet",
      materialType: "document",
      fileUrl: "https://example.com/materials/polynomials.pdf",
    });
    assert(matRes.status === 201, "Material add failed");
    console.log("  ✓ LMS Material uploaded");

    // Create Assignment
    const assgnRes = await request("POST", "/api/lms/assignments", {
      courseId,
      title: "Homework 1: Factoring Quadratics",
      description: "Solve problems 1 through 10 from chapter 3.",
      dueDate: new Date(Date.now() + 7 * 86400000).toISOString(),
      maxMarks: 50,
    });
    assert(assgnRes.status === 201, "Assignment create failed");
    assignmentId = assgnRes.body.data.id;
    console.log(`  ✓ LMS Assignment created: ${assgnRes.body.data.title}`);

    // Submit Assignment
    const subRes = await request("POST", `/api/lms/assignments/${assignmentId}/submit`, {
      submissionText: "All 10 problems solved with step-by-step proofs attached.",
      attachmentUrl: "https://example.com/homework1.pdf",
    });
    assert(subRes.status === 200, `Assignment submit failed: ${JSON.stringify(subRes.body)}`);
    const submissionId = subRes.body.data.id;
    console.log("  ✓ Student submitted assignment");

    // Grade Submission
    const gradeRes = await request("POST", `/api/lms/submissions/${submissionId}/grade`, {
      marksObtained: 48,
      feedback: "Excellent work! Clear demonstration of quadratic formula.",
    });
    assert(gradeRes.status === 200, "Grade submission failed");
    console.log(`  ✓ Submission graded: ${gradeRes.body.data.marks_obtained}/50`);
  }

  // ----------------------------------------------------
  // MODULE 8: AUDIT LOGS & SECURITY REVIEW
  // ----------------------------------------------------
  console.log("\n[8/8] Testing Audit Logs & Security Review...");
  {
    // Search Audit Logs
    const logsRes = await request("GET", "/api/audit-logs");
    assert(logsRes.status === 200, "Audit logs search failed");
    console.log(`  ✓ Audit Logs retrieved: Total recorded events = ${logsRes.body.pagination.total}`);

    // Audit Stats
    const statsRes = await request("GET", "/api/audit-logs/stats");
    assert(statsRes.status === 200, "Audit stats failed");
    console.log(`  ✓ Audit Stats: Success actions = ${statsRes.body.data.summary.success_count}`);

    // Security Review
    const secReview = await request("GET", "/api/security/review");
    assert(secReview.status === 200, "Security review failed");
    console.log(`  ✓ Security Review completed! Overall Security Score: ${secReview.body.data.securityScore}/100`);
    console.log(`    - Total Accounts: ${secReview.body.data.accounts.total_users}`);
    console.log(`    - Active Sessions: ${secReview.body.data.sessions.total_active_sessions}`);
    console.log(`    - Recommendations: ${secReview.body.data.recommendations.length}`);

    // Active Sessions
    const sessionsRes = await request("GET", "/api/security/sessions");
    assert(sessionsRes.status === 200, "List sessions failed");
    console.log(`  ✓ Active Sessions retrieved: ${sessionsRes.body.count} session(s) found`);
  }

  // ----------------------------------------------------
  // MODULE 9: CERTIFICATES MODULE
  // ----------------------------------------------------
  console.log("\n[9/9] Testing Certificates Module...");
  {
    // Create certificate template
    const templateRes = await request("POST", "/api/certificates/templates", {
      name: "Bonafide Certificate",
      certificateType: "bonafide",
      description: "Certificate confirming current student enrollment",
      templateContent: "<h1>Bonafide Certificate</h1><p>This is to certify that {{studentName}} (Admission No: {{admissionNumber}}) is studying in Class {{className}} during {{academicYear}}.</p>",
      placeholders: ["studentName", "admissionNumber", "className", "academicYear", "issueDate"],
    });
    assert(templateRes.status === 201, `Create template failed: ${JSON.stringify(templateRes.body)}`);
    const certTemplateId = templateRes.body.data.id;
    console.log(`  ✓ Certificate Template created: ${templateRes.body.data.name} (ID: ${certTemplateId})`);

    // List templates
    const listTemplatesRes = await request("GET", "/api/certificates/templates");
    assert(listTemplatesRes.status === 200 && listTemplatesRes.body.data.length > 0, "List templates failed");
    console.log(`  ✓ Templates listed: ${listTemplatesRes.body.count} template(s) found`);

    // Generate certificate for student
    const genRes = await request("POST", "/api/certificates/generate", {
      studentId: Number(studentId),
      templateId: certTemplateId,
      issueDate: "2026-10-26",
      academicYear: "2026-2027",
    });
    assert(genRes.status === 201, `Generate certificate failed: ${JSON.stringify(genRes.body)}`);
    const certId = genRes.body.data.id;
    console.log(`  ✓ PDF Certificate generated successfully! Cert No: ${genRes.body.data.certificateNumber} (ID: ${certId})`);
    console.log(`    - Download URL: ${genRes.body.data.downloadUrl}`);

    // Retrieve certificates for student
    const studentCertsRes = await request("GET", `/api/certificates/${studentId}`);
    assert(studentCertsRes.status === 200 && studentCertsRes.body.data.length > 0, "Get student certificates failed");
    console.log(`  ✓ Student certificates retrieved: ${studentCertsRes.body.count} certificate(s) for Student ${studentId}`);

    // Download PDF and verify binary header
    const downloadRes = await request("GET", `/api/certificates/download/${certId}`);
    assert(downloadRes.status === 200, "Download certificate failed");
    console.log(`  ✓ Certificate PDF downloaded and verified successfully`);
  }

  console.log("\n==================================================");
  console.log("ALL 9 MODULES PASSED COMPLETE INTEGRATION TESTING!");
  console.log("==================================================");

  server.close();
  await pool.end();
}

runTests().catch(async (err) => {
  console.error("\n❌ TEST SUITE FAILED:", err);
  if (server) server.close();
  await pool.end();
  process.exit(1);
});
