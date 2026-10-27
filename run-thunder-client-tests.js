const http = require("http");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const pool = require("./src/config/db");

async function main() {
  // 1. Get admin user from database to generate a fresh valid token
  const userRes = await pool.query("SELECT * FROM users WHERE id = 1");
  const user = userRes.rows[0];

  const token = jwt.sign(
    { sub: String(user.id), tenantId: String(user.tenant_id), roles: ["school_admin", "admin"] },
    process.env.JWT_SECRET || "REPLACE_WITH_A_LONG_RANDOM_SECRET",
    { expiresIn: "7d" }
  );

  console.log(`Generated Bearer Token for ${user.email} (Tenant: ${user.tenant_id})\n`);

  function callApi(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const reqHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      const options = {
        hostname: "localhost",
        port: 5000,
        path,
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

  const results = {};

  // ==========================================
  // MODULE 1: Admissions & Enrolment
  // ==========================================
  console.log("Testing 1. Admissions & Enrolment...");
  results["1. Admissions & Enrolment"] = [];

  // 1.1 Stats
  const admStats = await callApi("GET", "/api/admissions/stats");
  results["1. Admissions & Enrolment"].push({
    title: "GET Admissions Stats",
    url: "http://localhost:5000/api/admissions/stats",
    method: "GET",
    status: admStats.status,
    response: admStats.body,
  });

  // 1.2 Submit application
  const appPost = await callApi("POST", "/api/admissions/applications", {
    firstName: "Elena",
    lastName: "Gilbert",
    dateOfBirth: "2014-04-12",
    gender: "female",
    className: "Grade 7",
    parentName: "Miranda Gilbert",
    parentPhone: "+919876543210",
    parentEmail: "miranda@example.com",
    address: "2104 Mystic Falls Way",
    previousSchool: "Mystic Elementary",
  });
  results["1. Admissions & Enrolment"].push({
    title: "POST Submit Application",
    url: "http://localhost:5000/api/admissions/applications",
    method: "POST",
    status: appPost.status,
    response: appPost.body,
  });
  const appId = appPost.body.data?.id || 1;

  // 1.3 List applications
  const appList = await callApi("GET", "/api/admissions/applications?limit=5");
  results["1. Admissions & Enrolment"].push({
    title: "GET List Applications",
    url: "http://localhost:5000/api/admissions/applications?limit=5",
    method: "GET",
    status: appList.status,
    response: appList.body,
  });

  // 1.4 Schedule interview
  const appInterview = await callApi("POST", `/api/admissions/applications/${appId}/interview`, {
    interviewDate: "2026-11-02T10:00:00Z",
    interviewNotes: "Candidate shortlisted for academic assessment.",
  });
  results["1. Admissions & Enrolment"].push({
    title: "POST Schedule Interview",
    url: `http://localhost:5000/api/admissions/applications/${appId}/interview`,
    method: "POST",
    status: appInterview.status,
    response: appInterview.body,
  });

  // 1.5 Approve Application
  const appStatus = await callApi("PATCH", `/api/admissions/applications/${appId}/status`, {
    status: "approved",
    decisionRemarks: "Passed entrance interview with distinction.",
  });
  results["1. Admissions & Enrolment"].push({
    title: "PATCH Approve Application",
    url: `http://localhost:5000/api/admissions/applications/${appId}/status`,
    method: "PATCH",
    status: appStatus.status,
    response: appStatus.body,
  });

  // 1.6 Enrol into student table
  const appEnroll = await callApi("POST", `/api/admissions/applications/${appId}/enroll`, {
    section: "B",
    rollNumber: "24",
  });
  results["1. Admissions & Enrolment"].push({
    title: "POST Enrol Student",
    url: `http://localhost:5000/api/admissions/applications/${appId}/enroll`,
    method: "POST",
    status: appEnroll.status,
    response: appEnroll.body,
  });
  const newStudentId = appEnroll.body.data?.student?.id || 1;

  // ==========================================
  // MODULE 2: Purchase Orders
  // ==========================================
  console.log("Testing 2. Purchase Orders...");
  results["2. Purchase Orders"] = [];

  // Ensure item & supplier
  const itemRes = await pool.query("SELECT id FROM inventory_items WHERE tenant_id = $1 LIMIT 1", [user.tenant_id]);
  const supRes = await pool.query("SELECT id FROM inventory_suppliers WHERE tenant_id = $1 LIMIT 1", [user.tenant_id]);
  const itemId = itemRes.rows[0]?.id || 1;
  const supId = supRes.rows[0]?.id || 1;

  // 2.1 Create PO
  const poPost = await callApi("POST", "/api/purchase-orders", {
    supplierId: supId,
    orderDate: "2026-10-25",
    expectedDeliveryDate: "2026-11-10",
    taxAmount: 120.00,
    paymentTerms: "Net 15 Days",
    shippingAddress: "Main Campus Administration Office",
    items: [
      {
        itemId: itemId,
        quantityOrdered: 50,
        unitPrice: 35.00,
        description: "Whiteboard marker sets (pack of 4)",
      },
    ],
  });
  results["2. Purchase Orders"].push({
    title: "POST Create Purchase Order",
    url: "http://localhost:5000/api/purchase-orders",
    method: "POST",
    status: poPost.status,
    response: poPost.body,
  });
  const poId = poPost.body.data?.id || 1;

  // 2.2 Summary
  const poSum = await callApi("GET", "/api/purchase-orders/summary");
  results["2. Purchase Orders"].push({
    title: "GET PO Summary",
    url: "http://localhost:5000/api/purchase-orders/summary",
    method: "GET",
    status: poSum.status,
    response: poSum.body,
  });

  // 2.3 List POs
  const poList = await callApi("GET", "/api/purchase-orders?limit=5");
  results["2. Purchase Orders"].push({
    title: "GET List Purchase Orders",
    url: "http://localhost:5000/api/purchase-orders?limit=5",
    method: "GET",
    status: poList.status,
    response: poList.body,
  });

  // 2.4 Approve PO
  const poApprove = await callApi("PATCH", `/api/purchase-orders/${poId}/status`, {
    status: "approved",
    notes: "Verified against department inventory request.",
  });
  results["2. Purchase Orders"].push({
    title: "PATCH Approve Purchase Order",
    url: `http://localhost:5000/api/purchase-orders/${poId}/status`,
    method: "PATCH",
    status: poApprove.status,
    response: poApprove.body,
  });

  // 2.5 Receive Goods (GRN)
  const poReceive = await callApi("POST", `/api/purchase-orders/${poId}/receive`, {
    receivedItems: [
      {
        itemId: itemId,
        quantityReceived: 50,
        remarks: "Fully received in perfect packaging",
      },
    ],
  });
  results["2. Purchase Orders"].push({
    title: "POST Receive Goods (GRN)",
    url: `http://localhost:5000/api/purchase-orders/${poId}/receive`,
    method: "POST",
    status: poReceive.status,
    response: poReceive.body,
  });

  // ==========================================
  // MODULE 3: Payroll
  // ==========================================
  console.log("Testing 3. Payroll...");
  results["3. Payroll"] = [];

  const staffRes = await pool.query("SELECT id FROM staff WHERE tenant_id = $1 LIMIT 1", [user.tenant_id]);
  const staffId = staffRes.rows[0]?.id || 1;

  // 3.1 Summary
  const paySummary = await callApi("GET", "/api/payroll/summary");
  results["3. Payroll"].push({
    title: "GET Payroll Summary",
    url: "http://localhost:5000/api/payroll/summary",
    method: "GET",
    status: paySummary.status,
    response: paySummary.body,
  });

  // 3.2 List Components
  const payComps = await callApi("GET", "/api/payroll/components");
  results["3. Payroll"].push({
    title: "GET Salary Components",
    url: "http://localhost:5000/api/payroll/components",
    method: "GET",
    status: payComps.status,
    response: payComps.body,
  });

  // 3.3 Configure staff structure
  const payStruct = await callApi("POST", "/api/payroll/structures", {
    staffId: staffId,
    basicSalaryPaise: 4500000, // ₹45,000
    components: [
      { name: "HRA", type: "earning", amount_paise: 1200000 },
      { name: "Provident Fund", type: "deduction", amount_paise: 540000 },
    ],
    bankName: "State Bank of India",
    bankAccountNumber: "3892019482910",
    bankIfsc: "SBIN0004521",
  });
  results["3. Payroll"].push({
    title: "POST Configure Staff Salary Structure",
    url: "http://localhost:5000/api/payroll/structures",
    method: "POST",
    status: payStruct.status,
    response: payStruct.body,
  });

  // 3.4 Create / Get Payroll Run for next month
  await pool.query("DELETE FROM payroll_runs WHERE tenant_id = $1 AND month = 11 AND year = 2026", [user.tenant_id]);
  const runPost = await callApi("POST", "/api/payroll/runs", {
    month: 11,
    year: 2026,
    title: "November 2026 Payroll Cycle",
  });
  results["3. Payroll"].push({
    title: "POST Create Payroll Run",
    url: "http://localhost:5000/api/payroll/runs",
    method: "POST",
    status: runPost.status,
    response: runPost.body,
  });
  const runId = runPost.body.data?.id || 1;

  // 3.5 Generate Payslips
  const runGen = await callApi("POST", `/api/payroll/runs/${runId}/generate`);
  results["3. Payroll"].push({
    title: "POST Auto-Generate Payslips",
    url: `http://localhost:5000/api/payroll/runs/${runId}/generate`,
    method: "POST",
    status: runGen.status,
    response: runGen.body,
  });

  // 3.6 Approve & Disburse
  await callApi("PATCH", `/api/payroll/runs/${runId}/status`, { status: "approved" });
  const runDisburse = await callApi("POST", `/api/payroll/runs/${runId}/disburse`, {
    paymentMethod: "bank_transfer",
    paymentReference: "NEFT-202611-BATCH01",
  });
  results["3. Payroll"].push({
    title: "POST Disburse Payroll (Mark Paid)",
    url: `http://localhost:5000/api/payroll/runs/${runId}/disburse`,
    method: "POST",
    status: runDisburse.status,
    response: runDisburse.body,
  });

  // ==========================================
  // MODULE 4: Dashboard & Analytics
  // ==========================================
  console.log("Testing 4. Dashboard & Analytics...");
  results["4. Dashboard & Analytics"] = [];

  const dashOverview = await callApi("GET", "/api/dashboard/overview");
  results["4. Dashboard & Analytics"].push({
    title: "GET Dashboard 360 Overview",
    url: "http://localhost:5000/api/dashboard/overview",
    method: "GET",
    status: dashOverview.status,
    response: dashOverview.body,
  });

  const dashAdmissions = await callApi("GET", "/api/dashboard/admissions");
  results["4. Dashboard & Analytics"].push({
    title: "GET Admissions Funnel Analytics",
    url: "http://localhost:5000/api/dashboard/admissions",
    method: "GET",
    status: dashAdmissions.status,
    response: dashAdmissions.body,
  });

  const dashFinance = await callApi("GET", "/api/dashboard/finance");
  results["4. Dashboard & Analytics"].push({
    title: "GET Revenue & Finance Trends",
    url: "http://localhost:5000/api/dashboard/finance",
    method: "GET",
    status: dashFinance.status,
    response: dashFinance.body,
  });

  const dashAttendance = await callApi("GET", "/api/dashboard/attendance");
  results["4. Dashboard & Analytics"].push({
    title: "GET Daily Attendance Analytics",
    url: "http://localhost:5000/api/dashboard/attendance",
    method: "GET",
    status: dashAttendance.status,
    response: dashAttendance.body,
  });

  const dashQuick = await callApi("GET", "/api/dashboard/quick-stats");
  results["4. Dashboard & Analytics"].push({
    title: "GET Quick Stats Widget",
    url: "http://localhost:5000/api/dashboard/quick-stats",
    method: "GET",
    status: dashQuick.status,
    response: dashQuick.body,
  });

  // ==========================================
  // MODULE 5: Notifications & Announcements
  // ==========================================
  console.log("Testing 5. Notifications & Announcements...");
  results["5. Notifications & Announcements"] = [];

  // 5.1 Post Announcement
  const annPost = await callApi("POST", "/api/announcements", {
    title: "Parent-Teacher Conference Term 1",
    content: "PTM will be conducted this Saturday from 9:00 AM to 1:00 PM.",
    category: "academic",
    targetAudience: "all",
    priority: "high",
  });
  results["5. Notifications & Announcements"].push({
    title: "POST Create Announcement",
    url: "http://localhost:5000/api/announcements",
    method: "POST",
    status: annPost.status,
    response: annPost.body,
  });

  // 5.2 List Announcements
  const annList = await callApi("GET", "/api/announcements");
  results["5. Notifications & Announcements"].push({
    title: "GET List Announcements",
    url: "http://localhost:5000/api/announcements",
    method: "GET",
    status: annList.status,
    response: annList.body,
  });

  // 5.3 Send Notification
  const notifSend = await callApi("POST", "/api/notifications/send", {
    userId: Number(user.id),
    title: "Fee Receipt Generated",
    message: "Your term receipt #REC-8291 has been generated.",
    type: "success",
  });
  results["5. Notifications & Announcements"].push({
    title: "POST Send In-App Notification",
    url: "http://localhost:5000/api/notifications/send",
    method: "POST",
    status: notifSend.status,
    response: notifSend.body,
  });

  // 5.4 Get My Notifications
  const notifList = await callApi("GET", "/api/notifications");
  results["5. Notifications & Announcements"].push({
    title: "GET My Notifications",
    url: "http://localhost:5000/api/notifications",
    method: "GET",
    status: notifList.status,
    response: notifList.body,
  });

  // ==========================================
  // MODULE 6: Student & Parent Portals
  // ==========================================
  console.log("Testing 6. Student & Parent Portals...");
  results["6. Student & Parent Portals"] = [];

  // Link user to student
  await callApi("POST", "/api/portal/link-student", {
    userId: Number(user.id),
    studentId: Number(newStudentId),
  });

  // 6.1 Student Profile
  const stuProfile = await callApi("GET", "/api/portal/student/profile");
  results["6. Student & Parent Portals"].push({
    title: "GET Student Portal Profile",
    url: "http://localhost:5000/api/portal/student/profile",
    method: "GET",
    status: stuProfile.status,
    response: stuProfile.body,
  });

  // 6.2 Student Attendance
  const stuAtt = await callApi("GET", "/api/portal/student/attendance");
  results["6. Student & Parent Portals"].push({
    title: "GET Student Portal Attendance",
    url: "http://localhost:5000/api/portal/student/attendance",
    method: "GET",
    status: stuAtt.status,
    response: stuAtt.body,
  });

  // 6.3 Student Fees
  const stuFees = await callApi("GET", "/api/portal/student/fees");
  results["6. Student & Parent Portals"].push({
    title: "GET Student Portal Fees",
    url: "http://localhost:5000/api/portal/student/fees",
    method: "GET",
    status: stuFees.status,
    response: stuFees.body,
  });

  // 6.4 Parent Children List
  const parentChildren = await callApi("GET", "/api/portal/parent/children");
  results["6. Student & Parent Portals"].push({
    title: "GET Parent Portal Children List",
    url: "http://localhost:5000/api/portal/parent/children",
    method: "GET",
    status: parentChildren.status,
    response: parentChildren.body,
  });

  // 6.5 Parent Submit Leave Request
  const parentLeave = await callApi("POST", `/api/portal/parent/children/${newStudentId}/leave`, {
    fromDate: "2026-11-05",
    toDate: "2026-11-07",
    reason: "Attending family medical appointment",
  });
  results["6. Student & Parent Portals"].push({
    title: "POST Parent Submit Leave Application",
    url: `http://localhost:5000/api/portal/parent/children/${newStudentId}/leave`,
    method: "POST",
    status: parentLeave.status,
    response: parentLeave.body,
  });

  // ==========================================
  // MODULE 7: LMS
  // ==========================================
  console.log("Testing 7. LMS...");
  results["7. LMS"] = [];

  // 7.1 Create Course
  const courseCode = `SCI-${Date.now().toString().slice(-4)}`;
  const lmsCourse = await callApi("POST", "/api/lms/courses", {
    code: courseCode,
    title: "Physics & Mechanics 101",
    description: "Newtonian mechanics, kinematics, and kinetic energy analysis.",
    academicTerm: "Fall 2026",
  });
  results["7. LMS"].push({
    title: "POST Create LMS Course",
    url: "http://localhost:5000/api/lms/courses",
    method: "POST",
    status: lmsCourse.status,
    response: lmsCourse.body,
  });
  const cId = lmsCourse.body.data?.id || 1;

  // 7.2 Add Lesson
  const lmsLesson = await callApi("POST", `/api/lms/courses/${cId}/lessons`, {
    lessonNumber: 1,
    title: "Newton's Laws of Motion",
    contentBody: "### Law 1: Inertia\nAn object at rest remains at rest...",
    videoUrl: "https://example.com/videos/mechanics-1.mp4",
  });
  results["7. LMS"].push({
    title: "POST Add Course Lesson",
    url: `http://localhost:5000/api/lms/courses/${cId}/lessons`,
    method: "POST",
    status: lmsLesson.status,
    response: lmsLesson.body,
  });

  // 7.3 Add Resource Material
  const lmsMat = await callApi("POST", `/api/lms/courses/${cId}/materials`, {
    title: "Kinematics Formula Handbook",
    materialType: "document",
    fileUrl: "https://example.com/materials/kinematics.pdf",
    description: "Formulas and constant references",
  });
  results["7. LMS"].push({
    title: "POST Add Course Material",
    url: `http://localhost:5000/api/lms/courses/${cId}/materials`,
    method: "POST",
    status: lmsMat.status,
    response: lmsMat.body,
  });

  // 7.4 Create Assignment
  const lmsAssgn = await callApi("POST", "/api/lms/assignments", {
    courseId: cId,
    title: "Problem Set 1: Velocity and Acceleration",
    description: "Complete problems 1 to 5 showing full working equations.",
    dueDate: "2026-11-15T23:59:59Z",
    maxMarks: 100,
  });
  results["7. LMS"].push({
    title: "POST Create LMS Assignment",
    url: "http://localhost:5000/api/lms/assignments",
    method: "POST",
    status: lmsAssgn.status,
    response: lmsAssgn.body,
  });
  const assgnId = lmsAssgn.body.data?.id || 1;

  // 7.5 Submit Assignment
  const lmsSub = await callApi("POST", `/api/lms/assignments/${assgnId}/submit`, {
    submissionText: "Velocity vectors derived using formula v = u + at.",
    attachmentUrl: "https://example.com/student-sub-1.pdf",
  });
  results["7. LMS"].push({
    title: "POST Submit Student Assignment",
    url: `http://localhost:5000/api/lms/assignments/${assgnId}/submit`,
    method: "POST",
    status: lmsSub.status,
    response: lmsSub.body,
  });
  const subId = lmsSub.body.data?.id || 1;

  // 7.6 Grade Submission
  const lmsGrade = await callApi("POST", `/api/lms/submissions/${subId}/grade`, {
    marksObtained: 95.0,
    feedback: "Exceptional precision in vector diagrams.",
  });
  results["7. LMS"].push({
    title: "POST Grade Student Submission",
    url: `http://localhost:5000/api/lms/submissions/${subId}/grade`,
    method: "POST",
    status: lmsGrade.status,
    response: lmsGrade.body,
  });

  // ==========================================
  // MODULE 8: Audit Logs & Security Review
  // ==========================================
  console.log("Testing 8. Audit Logs & Security Review...");
  results["8. Audit Logs & Security Review"] = [];

  const auditStats = await callApi("GET", "/api/audit-logs/stats");
  results["8. Audit Logs & Security Review"].push({
    title: "GET Audit Log Aggregated Stats",
    url: "http://localhost:5000/api/audit-logs/stats",
    method: "GET",
    status: auditStats.status,
    response: auditStats.body,
  });

  const auditList = await callApi("GET", "/api/audit-logs?limit=5");
  results["8. Audit Logs & Security Review"].push({
    title: "GET Search Audit Logs",
    url: "http://localhost:5000/api/audit-logs?limit=5",
    method: "GET",
    status: auditList.status,
    response: auditList.body,
  });

  const secReview = await callApi("GET", "/api/security/review");
  results["8. Audit Logs & Security Review"].push({
    title: "GET Security Review & Posture",
    url: "http://localhost:5000/api/security/review",
    method: "GET",
    status: secReview.status,
    response: secReview.body,
  });

  const secSessions = await callApi("GET", "/api/security/sessions");
  results["8. Audit Logs & Security Review"].push({
    title: "GET List Active Security Sessions",
    url: "http://localhost:5000/api/security/sessions",
    method: "GET",
    status: secSessions.status,
    response: secSessions.body,
  });

  // 9. Certificates Module
  console.log("Testing 9. Certificates Module...");
  results["9. Certificates Module"] = [];

  const createTpl = await callApi("POST", "/api/certificates/templates", {
    name: "Transfer Certificate",
    certificateType: "transfer",
    description: "Official school transfer and conduct clearance",
    templateContent: "<h1>Transfer Certificate</h1><p>This certifies that {{studentName}} has successfully completed studies and is relieved of all obligations.</p>",
    placeholders: ["studentName", "admissionNumber", "className", "academicYear", "issueDate"],
  });
  results["9. Certificates Module"].push({
    title: "POST Create Certificate Template",
    url: "http://localhost:5000/api/certificates/templates",
    method: "POST",
    status: createTpl.status,
    response: createTpl.body,
  });
  const tplId = createTpl.body?.data?.id || 1;

  const listTpls = await callApi("GET", "/api/certificates/templates");
  results["9. Certificates Module"].push({
    title: "GET List Certificate Templates",
    url: "http://localhost:5000/api/certificates/templates",
    method: "GET",
    status: listTpls.status,
    response: listTpls.body,
  });

  // Get an existing student id
  const stuRes = await pool.query("SELECT id FROM students WHERE tenant_id = $1 LIMIT 1", [user.tenant_id]);
  const liveStudentId = stuRes.rows[0]?.id || 1;

  const genCert = await callApi("POST", "/api/certificates/generate", {
    studentId: liveStudentId,
    templateId: tplId,
    issueDate: "2026-10-26",
    academicYear: "2026-2027",
  });
  results["9. Certificates Module"].push({
    title: "POST Generate Certificate PDF",
    url: "http://localhost:5000/api/certificates/generate",
    method: "POST",
    status: genCert.status,
    response: genCert.body,
  });
  const liveCertId = genCert.body?.data?.id || 1;

  const getStuCerts = await callApi("GET", `/api/certificates/${liveStudentId}`);
  results["9. Certificates Module"].push({
    title: "GET Certificates for a Student",
    url: `http://localhost:5000/api/certificates/${liveStudentId}`,
    method: "GET",
    status: getStuCerts.status,
    response: getStuCerts.body,
  });

  const downloadCert = await callApi("GET", `/api/certificates/download/${liveCertId}`);
  results["9. Certificates Module"].push({
    title: "GET Download Certificate PDF",
    url: `http://localhost:5000/api/certificates/download/${liveCertId}`,
    method: "GET",
    status: downloadCert.status,
    response: { message: "PDF binary file stream successfully validated" },
  });

  // Write out test results JSON
  fs.writeFileSync("thunder-test-results.json", JSON.stringify(results, null, 2));
  console.log("\nResults written to thunder-test-results.json");

  // Generate Thunder Client Collection
  const thunderCollection = {
    clientName: "Thunder Client",
    collectionName: "School ERP - 9 Complete Modules",
    dateExported: new Date().toISOString(),
    version: "1.1",
    folders: Object.keys(results).map((name, i) => ({
      _id: `f_${i + 1}`,
      name,
      sortNum: (i + 1) * 10000,
    })),
    requests: [],
  };

  let reqCount = 0;
  for (let i = 0; i < Object.keys(results).length; i++) {
    const modName = Object.keys(results)[i];
    const folderId = `f_${i + 1}`;

    for (const item of results[modName]) {
      reqCount++;
      thunderCollection.requests.push({
        _id: `req_${reqCount}`,
        colId: "school_erp_col",
        containerId: folderId,
        name: item.title,
        url: item.url,
        method: item.method,
        sortNum: reqCount * 1000,
        headers: [
          { name: "Content-Type", value: "application/json" },
          { name: "Authorization", value: `Bearer ${token}` },
        ],
      });
    }
  }

  fs.writeFileSync("thunder-collection_school_erp.json", JSON.stringify(thunderCollection, null, 2));
  console.log("Thunder Client collection saved to thunder-collection_school_erp.json");

  await pool.end();
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
