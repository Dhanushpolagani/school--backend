-- db/seed/seed.sql

-- Create demo tenant
INSERT INTO tenants (name, slug, school_code, school_name, primary_color, timezone, currency, currency_symbol, locale)
VALUES ('Smart School ERP Demo', 'demo', 'DEMO', 'Smart School ERP Demo', '#f59e0b', 'Asia/Kolkata', 'INR', '₹', 'en-IN')
ON CONFLICT (slug) DO UPDATE
SET school_code = EXCLUDED.school_code,
    school_name = EXCLUDED.school_name,
    primary_color = EXCLUDED.primary_color;

-- Create super admin (password: Admin@123)
INSERT INTO users (tenant_id, full_name, email, password_hash, role, first_name, last_name, is_active, is_email_verified)
SELECT id, 'Super Admin', 'super@schoolerp.com',
  '$2a$12$RmJoUj8ZTlQEBbJSqU4XmeDHQ7nV2xGpAXI8o1H6vqYIvCHvV0e1.', -- bcrypt of 'Admin@123'
  'super_admin', 'Super', 'Admin', TRUE, TRUE
FROM tenants WHERE school_code = 'DEMO'
ON CONFLICT (tenant_id, email) DO NOTHING;

-- Create school admin (password: Admin@123)
INSERT INTO users (tenant_id, full_name, email, password_hash, role, first_name, last_name, is_active, is_email_verified)
SELECT id, 'School Admin', 'admin@demo.schoolerp.com',
  '$2a$12$RmJoUj8ZTlQEBbJSqU4XmeDHQ7nV2xGpAXI8o1H6vqYIvCHvV0e1.',
  'school_admin', 'School', 'Admin', TRUE, TRUE
FROM tenants WHERE school_code = 'DEMO'
ON CONFLICT (tenant_id, email) DO NOTHING;

-- Demo academic year
INSERT INTO academic_years (tenant_id, name, start_date, end_date, is_current)
SELECT id, '2026-27', '2026-04-01', '2027-03-31', TRUE
FROM tenants WHERE school_code = 'DEMO'
ON CONFLICT DO NOTHING;
