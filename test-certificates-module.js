const jwt = require("jsonwebtoken");
const http = require("http");
const fs = require("fs");
const path = require("path");
const app = require("./src/app");
const pool = require("./src/config/db");

let server;
let baseUrl;
let adminToken;
let parentToken;
let otherTenantToken;

let tenantId = "1";
let otherTenantId = "2";
let adminUserId;
let parentUserId;

function request(method, path, body = null, tokenToUse = adminToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders = {
      "Content-Type": "application/json",
    };
    if (tokenToUse) {
      reqHeaders["Authorization"] = `Bearer ${tokenToUse}`;
    }

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
    };

    const req = http.request(options, (res) => {
      const isPdf = res.headers["content-type"] === "application/pdf";
      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        let parsedBody;
        if (isPdf) {
          parsedBody = buffer;
        } else {
          try {
            parsedBody = JSON.parse(buffer.toString("utf8"));
          } catch {
            parsedBody = buffer.toString("utf8");
          }
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsedBody,
        });
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

async function runCertificatesTestSuite() {
  console.log("==========================================================");
  console.log("STARTING FULL CERTIFICATES MODULE INTEGRATION TEST SUITE");
  console.log("==========================================================");

  // 1. Start ephemeral test server
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Ephemeral test server running at ${baseUrl}`);

  // 2. Setup user and tokens
  const adminUserRes = await pool.query(
    "SELECT id, tenant_id, email FROM users WHERE tenant_id = $1 LIMIT 1",
    [tenantId]
  );
  assert(adminUserRes.rowCount > 0, "No admin user found for tenant 1");
  const adminUser = adminUserRes.rows[0];
  adminUserId = String(adminUser.id);
  tenantId = String(adminUser.tenant_id);

  const jwtSecret = process.env.JWT_SECRET || "REPLACE_WITH_A_LONG_RANDOM_SECRET_KEY_FOR_TESTS";

  adminToken = jwt.sign(
    { sub: adminUserId, tenantId, roles: ["school_admin", "admin"] },
    jwtSecret,
    { expiresIn: "1h" }
  );

  // Ensure a student exists in tenant 1
  let student1Res = await pool.query(
    `SELECT id, admission_number, first_name, last_name, class_name
     FROM students WHERE tenant_id = $1 LIMIT 1`,
    [tenantId]
  );
  let student1Id;
  if (student1Res.rowCount === 0) {
    const s1 = await pool.query(
      `INSERT INTO students (tenant_id, admission_number, first_name, last_name, class_name, section, status)
       VALUES ($1, 'ADM-TEST-01', 'Arjun', 'Kumar', 'Class 10', 'A', 'active')
       RETURNING id, admission_number, first_name, last_name, class_name`,
      [tenantId]
    );
    student1Id = s1.rows[0].id;
  } else {
    student1Id = student1Res.rows[0].id;
  }

  // Ensure a second student exists in tenant 1 for unlinked-parent testing
  let student2Res = await pool.query(
    `SELECT id FROM students WHERE tenant_id = $1 AND id != $2 LIMIT 1`,
    [tenantId, student1Id]
  );
  let student2Id;
  if (student2Res.rowCount === 0) {
    const s2 = await pool.query(
      `INSERT INTO students (tenant_id, admission_number, first_name, last_name, class_name, section, status)
       VALUES ($1, 'ADM-TEST-02', 'Priya', 'Sharma', 'Class 9', 'B', 'active')
       RETURNING id`,
      [tenantId]
    );
    student2Id = s2.rows[0].id;
  } else {
    student2Id = student2Res.rows[0].id;
  }

  // Ensure a parent user exists and is linked ONLY to student1
  const parentEmail = "parent_test_cert@example.com";
  let parentUserRes = await pool.query(
    `SELECT id FROM users WHERE tenant_id = $1 AND email = $2`,
    [tenantId, parentEmail]
  );
  if (parentUserRes.rowCount === 0) {
    const pu = await pool.query(
      `INSERT INTO users (tenant_id, full_name, email, password_hash)
       VALUES ($1, 'Ramesh Kumar', $2, 'hash') RETURNING id`,
      [tenantId, parentEmail]
    );
    parentUserId = String(pu.rows[0].id);
    const parentRole = await pool.query("SELECT id FROM roles WHERE name = 'parent'");
    if (parentRole.rowCount > 0) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [parentUserId, parentRole.rows[0].id]
      );
    }
  } else {
    parentUserId = String(parentUserRes.rows[0].id);
  }

  // Link parent to student1 in parents table and parent_users table
  let parentRecordRes = await pool.query(
    `SELECT id FROM parents WHERE tenant_id = $1 AND student_id = $2 AND email = $3`,
    [tenantId, student1Id, parentEmail]
  );
  let parentRecordId;
  if (parentRecordRes.rowCount === 0) {
    const pr = await pool.query(
      `INSERT INTO parents (tenant_id, student_id, full_name, relationship, email, phone)
       VALUES ($1, $2, 'Ramesh Kumar', 'father', $3, '9876543210') RETURNING id`,
      [tenantId, student1Id, parentEmail]
    );
    parentRecordId = pr.rows[0].id;
  } else {
    parentRecordId = parentRecordRes.rows[0].id;
  }

  await pool.query(
    `INSERT INTO parent_users (tenant_id, user_id, parent_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, parentUserId, parentRecordId]
  );

  parentToken = jwt.sign(
    { sub: parentUserId, tenantId, roles: ["parent"] },
    jwtSecret,
    { expiresIn: "1h" }
  );

  // Setup other tenant token
  // Check if tenant 2 exists
  let tenant2Res = await pool.query("SELECT id FROM tenants WHERE id = $1", [otherTenantId]);
  if (tenant2Res.rowCount === 0) {
    await pool.query(
      `INSERT INTO tenants (name, slug, email, phone)
       OVERRIDING SYSTEM VALUE
       VALUES ('Oakwood High', 'oakwood-high', 'admin@oakwood.test', '1122334455')
       ON CONFLICT (slug) DO NOTHING`
    );
  }
  otherTenantToken = jwt.sign(
    { sub: "999", tenantId: otherTenantId, roles: ["school_admin", "admin"] },
    jwtSecret,
    { expiresIn: "1h" }
  );

  console.log(`✓ Test environment ready.`);
  console.log(`  - Admin user ID: ${adminUserId} (Tenant ${tenantId})`);
  console.log(`  - Parent user ID: ${parentUserId} linked to Student ${student1Id}`);
  console.log(`  - Student 2 ID: ${student2Id} (unlinked to parent)`);

  let createdTemplateId;
  let generatedCertId;

  // -------------------------------------------------------------------------
  // TEST 1: GET /api/certificates/templates (Admin)
  // -------------------------------------------------------------------------
  console.log("\n[Test 1] GET /api/certificates/templates (Initial list)...");
  {
    const res = await request("GET", "/api/certificates/templates", null, adminToken);
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.success === true, "Response success must be true");
    assert(Array.isArray(res.body.data), "Response data must be an array");
    console.log(`  ✓ Successfully retrieved templates list (Count: ${res.body.count})`);
  }

  // -------------------------------------------------------------------------
  // TEST 2: POST /api/certificates/templates (Admin creates Bonafide template)
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] POST /api/certificates/templates (Create template)...");
  {
    const templatePayload = {
      name: "Bonafide Certificate",
      certificateType: "bonafide",
      description: "Certificate confirming current student enrollment",
      templateContent: "<h1>Bonafide Certificate</h1><p>This is to certify that {{studentName}} (Admission No: {{admissionNumber}}) is studying in Class {{className}} during {{academicYear}}.</p>",
      placeholders: [
        "studentName",
        "admissionNumber",
        "className",
        "academicYear",
        "issueDate"
      ],
    };

    const res = await request("POST", "/api/certificates/templates", templatePayload, adminToken);
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.success === true, "Expected success true");
    assert(res.body.data.id, "Expected created template to have id");
    assert(res.body.data.name === "Bonafide Certificate", "Template name match");
    assert(res.body.data.certificate_type === "bonafide", "Certificate type match");
    assert(String(res.body.data.tenant_id) === tenantId, "Tenant isolation match");

    createdTemplateId = res.body.data.id;
    console.log(`  ✓ Created template successfully: ID ${createdTemplateId} ("${res.body.data.name}")`);
  }

  // -------------------------------------------------------------------------
  // TEST 3: Confirm new template appears in GET /api/certificates/templates
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] Confirm created template in GET /api/certificates/templates...");
  {
    const res = await request("GET", "/api/certificates/templates", null, adminToken);
    assert(res.status === 200, "Expected 200");
    const found = res.body.data.find((t) => Number(t.id) === Number(createdTemplateId));
    assert(found, `Newly created template ${createdTemplateId} must be present in GET list`);
    console.log(`  ✓ Verified template ${createdTemplateId} appears in templates list`);
  }

  // -------------------------------------------------------------------------
  // TEST 4: POST /api/certificates/generate (Generate PDF certificate)
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] POST /api/certificates/generate (Generate PDF)...");
  {
    const generatePayload = {
      studentId: student1Id,
      templateId: createdTemplateId,
      issueDate: "2026-10-26",
      academicYear: "2026-2027",
    };

    const res = await request("POST", "/api/certificates/generate", generatePayload, adminToken);
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.success === true, "Expected success true");
    assert(res.body.data.id, "Expected certificate record ID");
    assert(res.body.data.certificateNumber, "Expected certificateNumber");
    assert(res.body.data.downloadUrl, "Expected downloadUrl");

    generatedCertId = res.body.data.id;
    console.log(`  ✓ Certificate generated successfully!`);
    console.log(`    - Certificate ID: ${generatedCertId}`);
    console.log(`    - Certificate Number: ${res.body.data.certificateNumber}`);
    console.log(`    - File Name: ${res.body.data.fileName}`);
    console.log(`    - Download URL: ${res.body.data.downloadUrl}`);
  }

  // -------------------------------------------------------------------------
  // TEST 5: Download & Verify PDF binary
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] GET /api/certificates/download/:id (Verify PDF content)...");
  {
    const res = await request("GET", `/api/certificates/download/${generatedCertId}`, null, adminToken);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.headers["content-type"] === "application/pdf", "Expected Content-Type application/pdf");
    assert(Buffer.isBuffer(res.body), "Expected response body to be buffer");
    assert(res.body.slice(0, 5).toString("ascii") === "%PDF-", "Expected valid %PDF- header magic bytes");
    console.log(`  ✓ Successfully downloaded PDF! Valid PDF binary header (%PDF-) verified (${res.body.length} bytes)`);
  }

  // -------------------------------------------------------------------------
  // TEST 6: GET /api/certificates/:studentId as Administrator
  // -------------------------------------------------------------------------
  console.log("\n[Test 6] GET /api/certificates/:studentId as school_admin...");
  {
    const res = await request("GET", `/api/certificates/${student1Id}`, null, adminToken);
    assert(res.status === 200, "Expected 200");
    assert(res.body.success === true, "Expected success true");
    assert(res.body.count >= 1, "Expected at least 1 certificate");
    const certItem = res.body.data.find((c) => Number(c.id) === Number(generatedCertId));
    assert(certItem, "Generated certificate must be in student list");
    assert(certItem.downloadUrl === `/api/certificates/download/${generatedCertId}`, "downloadUrl match");
    console.log(`  ✓ Admin retrieved ${res.body.count} certificate(s) for Student ${student1Id}`);
  }

  // -------------------------------------------------------------------------
  // TEST 7: GET /api/certificates/:studentId as Parent (Linked child)
  // -------------------------------------------------------------------------
  console.log("\n[Test 7] GET /api/certificates/:studentId as Parent (Linked child)...");
  {
    const res = await request("GET", `/api/certificates/${student1Id}`, null, parentToken);
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.success === true, "Expected success true");
    assert(res.body.count >= 1, "Expected linked parent to see student1's certificates");
    console.log(`  ✓ Authorized parent successfully retrieved child's certificates (${res.body.count} items)`);
  }

  // -------------------------------------------------------------------------
  // TEST 8: GET /api/certificates/:studentId as Parent (UNLINKED child -> 403)
  // -------------------------------------------------------------------------
  console.log("\n[Test 8] GET /api/certificates/:studentId as Parent (Unlinked student -> 403 Forbidden)...");
  {
    const res = await request("GET", `/api/certificates/${student2Id}`, null, parentToken);
    assert(res.status === 403, `Expected 403 Forbidden, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.success === false, "Expected success false");
    console.log(`  ✓ Access properly denied (403 Forbidden) for unlinked student`);
  }

  // -------------------------------------------------------------------------
  // TEST 9: Tenant isolation - Admin cannot access another tenant's student / template
  // -------------------------------------------------------------------------
  console.log("\n[Test 9] Tenant isolation check (Other tenant access -> 404 Not Found)...");
  {
    // Tenant 2 admin attempts to access Tenant 1's student certificates
    const res1 = await request("GET", `/api/certificates/${student1Id}`, null, otherTenantToken);
    assert(res1.status === 404, `Expected 404 Not Found for cross-tenant student, got ${res1.status}`);

    // Tenant 2 admin attempts to generate using Tenant 1's template
    const res2 = await request(
      "POST",
      "/api/certificates/generate",
      { studentId: student1Id, templateId: createdTemplateId },
      otherTenantToken
    );
    assert(res2.status === 404, `Expected 404 Not Found for cross-tenant generation, got ${res2.status}`);

    console.log(`  ✓ Tenant isolation strictly enforced across tenants (Cross-tenant requests returned 404)`);
  }

  // -------------------------------------------------------------------------
  // TEST 10: Parent role permissions on Admin-only routes (403 Insufficient permissions)
  // -------------------------------------------------------------------------
  console.log("\n[Test 10] RBAC check: Parent calling school_admin routes -> 403 Forbidden...");
  {
    const res1 = await request("GET", "/api/certificates/templates", null, parentToken);
    assert(res1.status === 403, `Expected 403 for parent on GET /templates, got ${res1.status}`);

    const res2 = await request("POST", "/api/certificates/templates", { name: "Test" }, parentToken);
    assert(res2.status === 403, `Expected 403 for parent on POST /templates, got ${res2.status}`);

    const res3 = await request("POST", "/api/certificates/generate", { studentId: 1, templateId: 1 }, parentToken);
    assert(res3.status === 403, `Expected 403 for parent on POST /generate, got ${res3.status}`);

    console.log(`  ✓ Parent role correctly blocked with 403 on admin-only endpoints`);
  }

  // -------------------------------------------------------------------------
  // TEST 11: Validation error handling (HTTP 400 Bad Request)
  // -------------------------------------------------------------------------
  console.log("\n[Test 11] Input validation checks (400 Bad Request)...");
  {
    // Missing required fields on POST /templates
    const res1 = await request("POST", "/api/certificates/templates", { name: "" }, adminToken);
    assert(res1.status === 400, `Expected 400 for empty name, got ${res1.status}`);

    // Invalid certificateType
    const res2 = await request(
      "POST",
      "/api/certificates/templates",
      { name: "My Cert", certificateType: "invalid_type", templateContent: "Body" },
      adminToken
    );
    assert(res2.status === 400, `Expected 400 for invalid certificateType, got ${res2.status}`);

    // Missing templateContent
    const res3 = await request(
      "POST",
      "/api/certificates/templates",
      { name: "My Cert", certificateType: "bonafide" },
      adminToken
    );
    assert(res3.status === 400, `Expected 400 for missing templateContent, got ${res3.status}`);

    // Invalid studentId on POST /generate
    const res4 = await request(
      "POST",
      "/api/certificates/generate",
      { studentId: "not-a-number", templateId: 1 },
      adminToken
    );
    assert(res4.status === 400, `Expected 400 for non-numeric studentId, got ${res4.status}`);

    // Invalid date on POST /generate
    const res5 = await request(
      "POST",
      "/api/certificates/generate",
      { studentId: student1Id, templateId: createdTemplateId, issueDate: "invalid-date" },
      adminToken
    );
    assert(res5.status === 400, `Expected 400 for invalid date, got ${res5.status}`);

    // Invalid studentId on GET /api/certificates/:studentId
    const res6 = await request("GET", "/api/certificates/abc", null, adminToken);
    assert(res6.status === 400, `Expected 400 for invalid studentId in URL, got ${res6.status}`);

    console.log(`  ✓ Validation properly rejected all malformed inputs with 400 Bad Request`);
  }

  // -------------------------------------------------------------------------
  // TEST 12: Empty certificates list for student without certificates
  // -------------------------------------------------------------------------
  console.log("\n[Test 12] Empty certificates list for student without certificates...");
  {
    const res = await request("GET", `/api/certificates/${student2Id}`, null, adminToken);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.success === true, "Expected success true");
    assert(Array.isArray(res.body.data) && res.body.data.length === 0, "Expected empty data array");
    assert(res.body.count === 0, "Expected count 0");
    console.log(`  ✓ Returned empty list with count 0 for student with no certificates`);
  }

  console.log("\n==========================================================");
  console.log("ALL 12 TEST SUITES PASSED SUCCESSFULLY!");
  console.log("==========================================================");

  server.close();
  await pool.end();
}

runCertificatesTestSuite().catch(async (err) => {
  console.error("\n❌ CERTIFICATES TEST SUITE FAILED:", err);
  if (server) server.close();
  await pool.end();
  process.exit(1);
});
