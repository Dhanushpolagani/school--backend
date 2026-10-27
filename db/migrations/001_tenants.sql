-- db/migrations/001_tenants.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tenants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_code     VARCHAR(20) UNIQUE NOT NULL,       -- e.g. 'STMARY'
  school_name     VARCHAR(200) NOT NULL,
  logo_url        TEXT,
  primary_color   VARCHAR(20) DEFAULT '#f59e0b',
  secondary_color VARCHAR(20) DEFAULT '#1e293b',
  tagline         TEXT,
  address         TEXT,
  phone           VARCHAR(20),
  email           VARCHAR(150),
  website         VARCHAR(200),
  timezone        VARCHAR(60) DEFAULT 'Asia/Kolkata',
  currency        VARCHAR(10) DEFAULT 'INR',
  currency_symbol VARCHAR(5) DEFAULT '₹',
  locale          VARCHAR(20) DEFAULT 'en-IN',
  academic_year_pattern VARCHAR(30) DEFAULT 'April-March',
  enabled_modules TEXT[] DEFAULT ARRAY[
    'dashboard','school_admin','students','parents',
    'academics','exams','timetable','hr','payroll',
    'attendance','admissions','finance','communication',
    'transport','library','inventory','hostel',
    'reports','ai_hub','security','audit_log'
  ],
  plan            VARCHAR(30) DEFAULT 'basic',       -- basic | standard | premium
  plan_status     VARCHAR(20) DEFAULT 'active',      -- active | trial | suspended | churned
  trial_ends_at   TIMESTAMPTZ,
  mrr             NUMERIC(12,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_school_code ON tenants(school_code);
