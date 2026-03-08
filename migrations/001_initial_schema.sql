-- ═══════════════════════════════════════════════════════════════════════
-- GravityClaw — Tier 3: Supabase Schema Migration
-- Run this against your Supabase PostgreSQL instance
-- ═══════════════════════════════════════════════════════════════════════

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── data_store ────────────────────────────────────────────────────────
-- Arbitrary key-value storage for app settings or generic metrics
CREATE TABLE IF NOT EXISTS data_store (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  data_type TEXT NOT NULL DEFAULT 'json' CHECK (data_type IN ('number', 'text', 'json')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_store_key ON data_store(key);

-- ─── clients_crm ──────────────────────────────────────────────────────
-- Centralized client, customer, or lead tracking
CREATE TABLE IF NOT EXISTS clients_crm (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'lead' CHECK (status IN ('lead', 'active', 'past')),
  lifetime_value NUMERIC(12, 2) DEFAULT 0,
  last_contact TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_status ON clients_crm(status);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients_crm(email);

-- ─── sales_transactions ───────────────────────────────────────────────
-- Revenue tracking for services rendered or digital products sold
CREATE TABLE IF NOT EXISTS sales_transactions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  transaction_id TEXT UNIQUE NOT NULL,
  client_id UUID REFERENCES clients_crm(id) ON DELETE SET NULL,
  amount_usd NUMERIC(12, 2) NOT NULL,
  product_service_name TEXT NOT NULL,
  date TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_client ON sales_transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales_transactions(date);

-- ─── marketing_metrics ────────────────────────────────────────────────
-- Synced performance data from socials, ads, or newsletters
CREATE TABLE IF NOT EXISTS marketing_metrics (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('X', 'LinkedIn', 'Email', 'Instagram', 'YouTube', 'Website', 'Other')),
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  spend_usd NUMERIC(10, 2) DEFAULT 0,
  date TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_platform ON marketing_metrics(platform);
CREATE INDEX IF NOT EXISTS idx_marketing_date ON marketing_metrics(date);

-- ─── client_insights ──────────────────────────────────────────────────
-- AI-generated summaries of client calls, emails, or feedback
CREATE TABLE IF NOT EXISTS client_insights (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  client_id UUID REFERENCES clients_crm(id) ON DELETE CASCADE,
  sentiment TEXT,
  key_pain_points JSONB DEFAULT '[]'::jsonb,
  action_items JSONB DEFAULT '[]'::jsonb,
  next_steps TEXT,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insights_client ON client_insights(client_id);

-- ─── activity_log ─────────────────────────────────────────────────────
-- Every automated system or bot action logged for the dashboard
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  action TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'fail')),
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action);

-- ─── cost_log ─────────────────────────────────────────────────────────
-- SaaS, API, and LLM cost tracking to monitor profit margins
CREATE TABLE IF NOT EXISTS cost_log (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  service TEXT NOT NULL,
  usage_metric TEXT,
  cost_usd NUMERIC(10, 4) NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cost_service ON cost_log(service);
CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_log(timestamp);

-- ─── Updated-at trigger ───────────────────────────────────────────────
-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  -- data_store
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_data_store') THEN
    CREATE TRIGGER set_updated_at_data_store
      BEFORE UPDATE ON data_store
      FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
  END IF;

  -- clients_crm
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_clients_crm') THEN
    CREATE TRIGGER set_updated_at_clients_crm
      BEFORE UPDATE ON clients_crm
      FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Done. All 7 Tier 3 tables created with indexes and triggers.
-- ═══════════════════════════════════════════════════════════════════════
