-- ─────────────────────────────────────────────────────────────────────────
-- Banco de METADADOS do Data Hub no MariaDB 10.11 — estado equivalente às
-- migrations 001 a 043 do Postgres (tirado do esquema final, não refeito
-- passo a passo). Daqui em diante, cada migration nova existe nas DUAS pastas
-- com o MESMO nome (src/db/migrations e src/db/migrations-mariadb); o
-- mariadb:smoke e o boot conferem isso.
--
-- Equivalências (Postgres → MariaDB):
--   uuid               → UUID (nativo desde a 10.7)
--   timestamptz        → DATETIME(6), sempre em UTC (a sessão usa +00:00)
--   jsonb              → JSON (texto validado)
--   text[]             → JSON (array)
--   vector(384)        → LONGTEXT (o texto '[…]' que o pgvector devolve)
--   text de chave      → VARCHAR (índice exige tamanho); texto livre → TEXT/MEDIUMTEXT
--   índice único parcial → coluna gerada INVISÍVEL + UNIQUE (NULL não colide)
-- Colação utf8mb4_nopad_bin: compara como o Postgres (maiúscula ≠ minúscula,
-- 'a' ≠ 'a ').
--
-- Os comandos são idempotentes (IF NOT EXISTS): o MariaDB não desfaz DDL em
-- transação, então uma falha no meio pode ser retomada rodando de novo.
-- ─────────────────────────────────────────────────────────────────────────

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID NOT NULL DEFAULT (UUID()),
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'active',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY tenants_slug_key (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS users (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  email VARCHAR(320) NOT NULL,
  name VARCHAR(500) NOT NULL DEFAULT '',
  picture TEXT,
  auth_provider VARCHAR(64) NOT NULL DEFAULT 'google',
  last_login_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY users_email_key (email),
  KEY users_tenant_idx (tenant_id),
  CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS roles (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  builtin BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id),
  UNIQUE KEY roles_tenant_id_name_key (tenant_id, name),
  CONSTRAINT roles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL,
  role_id UUID NOT NULL,
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  tenant_id UUID NOT NULL,
  user_email VARCHAR(320),
  action VARCHAR(255) NOT NULL,
  resource_type VARCHAR(255),
  resource_id VARCHAR(255),
  detail JSON,
  ip VARCHAR(255),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY audit_logs_tenant_time_idx (tenant_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS source_connections (
  id VARCHAR(128) NOT NULL,
  name VARCHAR(500) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  host VARCHAR(500),
  port INT,
  "database" VARCHAR(500),
  username VARCHAR(500),
  password_enc TEXT,
  "ssl" BOOLEAN NOT NULL DEFAULT FALSE,
  created_by VARCHAR(320),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  config JSON,
  writable BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id),
  CONSTRAINT source_connections_kind_check CHECK (kind IN ('postgres', 'mysql', 'http'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS sync_schedules (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  name VARCHAR(500) NOT NULL,
  interval_minutes INT NOT NULL,
  start_time VARCHAR(5) NOT NULL,
  end_time VARCHAR(5) NOT NULL,
  weekdays SMALLINT NOT NULL,
  created_by VARCHAR(320),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY sync_schedules_tenant_idx (tenant_id),
  CONSTRAINT sync_schedules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT sync_schedules_end_time_check CHECK (end_time REGEXP '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT sync_schedules_interval_minutes_check CHECK (interval_minutes >= 1 AND interval_minutes <= 1440),
  CONSTRAINT sync_schedules_start_time_check CHECK (start_time REGEXP '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT sync_schedules_weekdays_check CHECK (weekdays >= 1 AND weekdays <= 127)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS datasets (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  connection_id VARCHAR(128) NOT NULL,
  schema_name VARCHAR(255) NOT NULL,
  object_name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  description MEDIUMTEXT NOT NULL DEFAULT '',
  tags JSON NOT NULL DEFAULT '[]',
  owner_email VARCHAR(320),
  visibility VARCHAR(32) NOT NULL DEFAULT 'private',
  sync_mode VARCHAR(32) NOT NULL DEFAULT 'live',
  incremental_key VARCHAR(255),
  row_count BIGINT,
  last_sync_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  watermark TEXT,
  kind VARCHAR(32) NOT NULL DEFAULT 'source',
  transform_sql MEDIUMTEXT,
  official BOOLEAN NOT NULL DEFAULT FALSE,
  sync_cadence VARCHAR(32) NOT NULL DEFAULT 'daily',
  embedding LONGTEXT,
  embedding_text MEDIUMTEXT,
  embedded_at DATETIME(6),
  sync_since TEXT,
  source_config JSON,
  schedule_id UUID,
  incremental_key_2 VARCHAR(255),
  watermark_2 TEXT,
  dedupe_keys JSON NOT NULL DEFAULT '[]',
  sync_since_days INT,
  watermark_lag_minutes INT NOT NULL DEFAULT 0,
  last_full_reload_at DATETIME(6),
  sync_failures INT NOT NULL DEFAULT 0,
  sync_paused_reason TEXT,
  databricks_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  databricks_mode VARCHAR(32) NOT NULL DEFAULT 'SNAPSHOT',
  databricks_layer VARCHAR(32),
  PRIMARY KEY (id),
  UNIQUE KEY datasets_tenant_id_connection_id_schema_name_object_name_key (tenant_id, connection_id, schema_name, object_name),
  UNIQUE KEY datasets_tenant_id_slug_key (tenant_id, slug),
  KEY datasets_tenant_idx (tenant_id),
  -- Sem "ON DELETE SET NULL": o MariaDB não deixa coluna com ação de FK entrar
  -- em CHECK (o pareamento abaixo). Não muda nada na prática — no Postgres o SET
  -- NULL também violaria o pareamento, e o código já desvincula os conjuntos
  -- antes de excluir o agendamento (schedulesRouter, DELETE).
  CONSTRAINT datasets_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES sync_schedules (id),
  CONSTRAINT datasets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT datasets_databricks_layer_check CHECK (databricks_layer IS NULL OR databricks_layer IN ('bronze', 'prata', 'ouro')),
  CONSTRAINT datasets_databricks_mode_check CHECK (databricks_mode IN ('SNAPSHOT', 'INCREMENTAL')),
  CONSTRAINT datasets_key2_needs_dedupe CHECK (incremental_key_2 IS NULL OR JSON_LENGTH(dedupe_keys) > 0),
  CONSTRAINT datasets_kind_check CHECK (kind IN ('source', 'derived')),
  CONSTRAINT datasets_schedule_pairing_check CHECK ((sync_cadence = 'schedule') = (schedule_id IS NOT NULL)),
  CONSTRAINT datasets_sync_cadence_check CHECK (sync_cadence IN ('daily', 'hourly', 'manual', 'cascade', 'schedule')),
  CONSTRAINT datasets_sync_since_days_range CHECK (sync_since_days IS NULL OR (sync_since_days >= 1 AND sync_since_days <= 3650)),
  CONSTRAINT datasets_sync_since_exclusive CHECK (sync_since IS NULL OR sync_since_days IS NULL),
  CONSTRAINT datasets_watermark_lag_range CHECK (watermark_lag_minutes >= 0 AND watermark_lag_minutes <= 10080)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS dataset_fields (
  id UUID NOT NULL DEFAULT (UUID()),
  dataset_id UUID NOT NULL,
  source_column VARCHAR(255) NOT NULL,
  "key" VARCHAR(255) NOT NULL,
  label VARCHAR(500) NOT NULL,
  description MEDIUMTEXT,
  type VARCHAR(32) NOT NULL DEFAULT 'text',
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  "sensitive" BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY dataset_fields_dataset_id_key_key (dataset_id, "key"),
  UNIQUE KEY dataset_fields_dataset_id_source_column_key (dataset_id, source_column),
  KEY dataset_fields_dataset_idx (dataset_id),
  CONSTRAINT dataset_fields_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS teams (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  description MEDIUMTEXT NOT NULL DEFAULT '',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY teams_tenant_id_slug_key (tenant_id, slug),
  KEY teams_tenant_idx (tenant_id),
  CONSTRAINT teams_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS team_members (
  team_id UUID NOT NULL,
  user_email VARCHAR(320) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (team_id, user_email),
  KEY team_members_email_idx (user_email),
  CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS dataset_grants (
  id UUID NOT NULL DEFAULT (UUID()),
  dataset_id UUID NOT NULL,
  team_id UUID,
  grantee_email VARCHAR(320),
  can_export BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(320) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  -- únicos "parciais" do Postgres (where x is not null): no MariaDB, NULL não colide
  UNIQUE KEY dataset_grants_uq_email (dataset_id, grantee_email),
  UNIQUE KEY dataset_grants_uq_team (dataset_id, team_id),
  KEY dataset_grants_dataset_idx (dataset_id),
  KEY dataset_grants_email_idx (grantee_email),
  CONSTRAINT dataset_grants_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
  CONSTRAINT dataset_grants_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  CONSTRAINT dataset_grants_check CHECK ((team_id IS NOT NULL) <> (grantee_email IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS sync_runs (
  id UUID NOT NULL DEFAULT (UUID()),
  dataset_id UUID NOT NULL,
  mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  "rows" BIGINT NOT NULL DEFAULT 0,
  bytes BIGINT NOT NULL DEFAULT 0,
  error MEDIUMTEXT,
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at DATETIME(6),
  compacted BOOLEAN NOT NULL DEFAULT FALSE,
  compact_ms INT,
  parts INT,
  PRIMARY KEY (id),
  KEY sync_runs_dataset_idx (dataset_id, started_at DESC),
  KEY sync_runs_started_idx (started_at DESC),
  CONSTRAINT sync_runs_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS saved_views (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  dataset_id UUID NOT NULL,
  name VARCHAR(500) NOT NULL,
  definition JSON NOT NULL DEFAULT '{}',
  owner_email VARCHAR(320) NOT NULL,
  shared BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY saved_views_dataset_idx (dataset_id),
  CONSTRAINT saved_views_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
  CONSTRAINT saved_views_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS dashboards (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  name VARCHAR(500) NOT NULL,
  description MEDIUMTEXT NOT NULL DEFAULT '',
  owner_email VARCHAR(320) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  visibility VARCHAR(32) NOT NULL DEFAULT 'private',
  settings JSON,
  PRIMARY KEY (id),
  KEY dashboards_tenant_idx (tenant_id),
  CONSTRAINT dashboards_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS dashboard_tabs (
  id UUID NOT NULL DEFAULT (UUID()),
  dashboard_id UUID NOT NULL,
  label VARCHAR(500) NOT NULL DEFAULT 'Geral',
  icon VARCHAR(255),
  sort_order INT NOT NULL DEFAULT 0,
  config JSON,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY dashboard_tabs_dashboard_idx (dashboard_id, sort_order),
  CONSTRAINT dashboard_tabs_dashboard_id_fkey FOREIGN KEY (dashboard_id) REFERENCES dashboards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS widgets (
  id UUID NOT NULL DEFAULT (UUID()),
  dashboard_id UUID NOT NULL,
  dataset_id UUID,
  title VARCHAR(1000) NOT NULL DEFAULT '',
  type VARCHAR(64) NOT NULL,
  dimension VARCHAR(500),
  metric JSON NOT NULL,
  filters JSON NOT NULL DEFAULT '[]',
  size VARCHAR(32) NOT NULL DEFAULT 'md',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  tab_id UUID,
  layout JSON,
  style JSON,
  spec JSON,
  PRIMARY KEY (id),
  KEY widgets_dashboard_idx (dashboard_id, sort_order),
  KEY widgets_tab_idx (tab_id, sort_order),
  CONSTRAINT widgets_dashboard_id_fkey FOREIGN KEY (dashboard_id) REFERENCES dashboards (id) ON DELETE CASCADE,
  CONSTRAINT widgets_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
  CONSTRAINT widgets_tab_id_fkey FOREIGN KEY (tab_id) REFERENCES dashboard_tabs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS dashboard_grants (
  id UUID NOT NULL DEFAULT (UUID()),
  dashboard_id UUID NOT NULL,
  grantee_email VARCHAR(320),
  level VARCHAR(32) NOT NULL DEFAULT 'view',
  created_by VARCHAR(320) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  team_id UUID,
  PRIMARY KEY (id),
  UNIQUE KEY dashboard_grants_dashboard_id_grantee_email_key (dashboard_id, grantee_email),
  UNIQUE KEY dashboard_grants_uq_team (dashboard_id, team_id),
  CONSTRAINT dashboard_grants_dashboard_id_fkey FOREIGN KEY (dashboard_id) REFERENCES dashboards (id) ON DELETE CASCADE,
  CONSTRAINT dashboard_grants_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  CONSTRAINT dashboard_grants_target_chk CHECK ((team_id IS NOT NULL) <> (grantee_email IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  user_email VARCHAR(320) NOT NULL,
  title VARCHAR(1000) NOT NULL DEFAULT 'Nova conversa',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY conversations_user_idx (tenant_id, user_email, updated_at DESC),
  CONSTRAINT conversations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS messages (
  id UUID NOT NULL DEFAULT (UUID()),
  conversation_id UUID NOT NULL,
  role VARCHAR(32) NOT NULL,
  content LONGTEXT NOT NULL DEFAULT '',
  chart JSON,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  trace JSON,
  PRIMARY KEY (id),
  KEY messages_conversation_idx (conversation_id, created_at),
  CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS metrics (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  dataset_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  description MEDIUMTEXT NOT NULL DEFAULT '',
  agg VARCHAR(32) NOT NULL,
  field_key VARCHAR(255) NOT NULL,
  filters JSON NOT NULL DEFAULT '[]',
  format VARCHAR(32) NOT NULL DEFAULT 'number',
  owner_email VARCHAR(320),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY metrics_tenant_id_slug_key (tenant_id, slug),
  KEY metrics_dataset_idx (dataset_id),
  CONSTRAINT metrics_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
  CONSTRAINT metrics_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS api_credentials (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  name VARCHAR(500) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  dataset_slugs JSON NOT NULL DEFAULT '[]',
  owner_email VARCHAR(320) NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at DATETIME(6),
  expires_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  write_slugs JSON NOT NULL DEFAULT '[]',
  rate_limit_per_min INT,
  quota_per_day INT,
  upstream_slugs JSON NOT NULL DEFAULT '[]',
  PRIMARY KEY (id),
  UNIQUE KEY api_credentials_token_hash_key (token_hash),
  CONSTRAINT api_credentials_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS api_call_metrics (
  id BIGINT NOT NULL AUTO_INCREMENT,
  dataset_slug VARCHAR(255),
  connection_id VARCHAR(128),
  endpoint TEXT,
  status INT,
  ok BOOLEAN NOT NULL,
  duration_ms INT,
  "rows" INT,
  bytes BIGINT,
  error MEDIUMTEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  check_type VARCHAR(32) NOT NULL DEFAULT 'sync' COMMENT 'origem da linha: sync (ingestão) | healthcheck | public (API gerada) | gateway (proxy de upstream)',
  credential_id UUID,
  request_id VARCHAR(255),
  method VARCHAR(16),
  upstream_slug VARCHAR(255),
  upstream_ms INT,
  consumer_ip VARCHAR(255),
  PRIMARY KEY (id),
  KEY api_call_metrics_created_idx (created_at DESC),
  KEY api_call_metrics_credential_idx (credential_id, created_at DESC),
  KEY api_call_metrics_dataset_idx (dataset_slug, created_at DESC),
  KEY api_call_metrics_upstream_idx (upstream_slug, created_at DESC),
  CONSTRAINT api_call_metrics_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES api_credentials (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS api_usage_daily (
  credential_id UUID NOT NULL,
  day DATE NOT NULL,
  calls INT NOT NULL DEFAULT 0,
  PRIMARY KEY (credential_id, day),
  KEY api_usage_daily_day_idx (day DESC),
  CONSTRAINT api_usage_daily_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES api_credentials (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS api_write_products (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  connection_id VARCHAR(128) NOT NULL,
  schema_name VARCHAR(255) NOT NULL,
  table_name VARCHAR(255) NOT NULL,
  columns JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(320),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY api_write_products_tenant_id_slug_key (tenant_id, slug),
  KEY api_write_products_tenant_idx (tenant_id),
  CONSTRAINT api_write_products_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS api_products (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  method VARCHAR(16) NOT NULL,
  owner_email VARCHAR(320) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  dataset_slug VARCHAR(255),
  pagination VARCHAR(32),
  default_limit INT,
  max_limit INT,
  read_filters JSON,
  connection_id VARCHAR(128),
  schema_name VARCHAR(255),
  table_name VARCHAR(255),
  columns JSON,
  reviewed_by VARCHAR(320),
  reviewed_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  write_op VARCHAR(32),
  key_columns JSON,
  max_affected INT,
  PRIMARY KEY (id),
  UNIQUE KEY api_products_tenant_id_slug_key (tenant_id, slug),
  KEY api_products_status_idx (tenant_id, status),
  KEY api_products_tenant_idx (tenant_id),
  CONSTRAINT api_products_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS health_checks (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  name VARCHAR(500) NOT NULL,
  url TEXT NOT NULL,
  connection_id VARCHAR(128),
  interval_minutes INT NOT NULL DEFAULT 5,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at DATETIME(6),
  created_by VARCHAR(320),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY health_checks_tenant_idx (tenant_id),
  CONSTRAINT health_checks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS gateway_upstreams (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  description MEDIUMTEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL,
  auth_mode VARCHAR(32) NOT NULL DEFAULT 'none',
  auth_header VARCHAR(255),
  auth_secret_enc TEXT,
  methods JSON NOT NULL DEFAULT '["GET"]',
  timeout_ms INT NOT NULL DEFAULT 15000,
  strip_prefix BOOLEAN NOT NULL DEFAULT TRUE,
  forward_headers JSON NOT NULL DEFAULT '[]',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  owner_email VARCHAR(320) NOT NULL,
  reviewed_by VARCHAR(320),
  reviewed_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY gateway_upstreams_tenant_id_slug_key (tenant_id, slug),
  KEY gateway_upstreams_tenant_idx (tenant_id, status),
  CONSTRAINT gateway_upstreams_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS ml_models (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  description MEDIUMTEXT NOT NULL DEFAULT '',
  task VARCHAR(64) NOT NULL,
  algorithm VARCHAR(64) NOT NULL,
  dataset_slug VARCHAR(255),
  feature_sql MEDIUMTEXT,
  target_column VARCHAR(255),
  excluded_columns JSON NOT NULL DEFAULT '[]',
  holdout_pct INT NOT NULL DEFAULT 20,
  max_rows INT NOT NULL DEFAULT 200000,
  hyperparams JSON NOT NULL DEFAULT '{}',
  retrain VARCHAR(32) NOT NULL DEFAULT 'manual',
  owner_email VARCHAR(320) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  promoted_version_id UUID,
  PRIMARY KEY (id),
  UNIQUE KEY ml_models_tenant_id_slug_key (tenant_id, slug),
  KEY ml_models_tenant_idx (tenant_id),
  CONSTRAINT ml_models_promoted_version_id_fkey FOREIGN KEY (promoted_version_id) REFERENCES ml_model_versions (id) ON DELETE SET NULL,
  CONSTRAINT ml_models_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS ml_model_versions (
  id UUID NOT NULL DEFAULT (UUID()),
  model_id UUID NOT NULL,
  version INT NOT NULL,
  artifact JSON,
  artifact_path TEXT,
  feature_schema JSON NOT NULL,
  metrics JSON NOT NULL DEFAULT '{}',
  importances JSON,
  rows_trained INT,
  rows_holdout INT,
  trained_ms INT,
  status VARCHAR(32) NOT NULL DEFAULT 'ready',
  note MEDIUMTEXT,
  created_by VARCHAR(320) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY ml_model_versions_model_id_version_key (model_id, version),
  KEY ml_model_versions_model_idx (model_id, version DESC),
  CONSTRAINT ml_model_versions_model_id_fkey FOREIGN KEY (model_id) REFERENCES ml_models (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS ml_training_runs (
  id UUID NOT NULL DEFAULT (UUID()),
  model_id UUID NOT NULL,
  version_id UUID,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  "trigger" VARCHAR(32) NOT NULL DEFAULT 'manual',
  "rows" INT,
  error MEDIUMTEXT,
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at DATETIME(6),
  PRIMARY KEY (id),
  KEY ml_training_runs_model_idx (model_id, started_at DESC),
  CONSTRAINT ml_training_runs_model_id_fkey FOREIGN KEY (model_id) REFERENCES ml_models (id) ON DELETE CASCADE,
  CONSTRAINT ml_training_runs_version_id_fkey FOREIGN KEY (version_id) REFERENCES ml_model_versions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS ml_drift_checks (
  id BIGINT NOT NULL AUTO_INCREMENT,
  model_id UUID NOT NULL,
  version_id UUID,
  checked_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  rows_scored INT,
  prediction_stats JSON NOT NULL DEFAULT '{}',
  live_metrics JSON,
  -- numeric no Postgres (texto no driver); DECIMAL no MariaDB também volta texto
  drift_score DECIMAL(38,10),
  alert BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id),
  KEY ml_drift_checks_model_idx (model_id, checked_at DESC),
  CONSTRAINT ml_drift_checks_model_id_fkey FOREIGN KEY (model_id) REFERENCES ml_models (id) ON DELETE CASCADE,
  CONSTRAINT ml_drift_checks_version_id_fkey FOREIGN KEY (version_id) REFERENCES ml_model_versions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS notebooks (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  description MEDIUMTEXT NOT NULL DEFAULT '',
  cells JSON NOT NULL DEFAULT '[]',
  visibility VARCHAR(32) NOT NULL DEFAULT 'private',
  owner_email VARCHAR(320) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY notebooks_tenant_id_slug_key (tenant_id, slug),
  KEY notebooks_owner_idx (owner_email),
  KEY notebooks_tenant_idx (tenant_id, updated_at DESC),
  CONSTRAINT notebooks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS notebook_grants (
  notebook_id UUID NOT NULL,
  grantee_email VARCHAR(320),
  team_id UUID,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY notebook_grants_email_idx (notebook_id, grantee_email),
  UNIQUE KEY notebook_grants_team_idx (notebook_id, team_id),
  CONSTRAINT notebook_grants_notebook_id_fkey FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE,
  CONSTRAINT notebook_grants_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  CONSTRAINT notebook_grants_check CHECK (grantee_email IS NOT NULL OR team_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS ai_providers (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  model VARCHAR(255) NOT NULL,
  api_key_enc TEXT,
  key_hint VARCHAR(255),
  base_url TEXT,
  max_tokens INT NOT NULL DEFAULT 16000,
  effort VARCHAR(32),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  last_test_at DATETIME(6),
  last_test_ok BOOLEAN,
  last_test_error MEDIUMTEXT,
  last_test_ms INT,
  owner_email VARCHAR(320) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- "um padrão por tenant" (índice único parcial where is_default no Postgres)
  default_tenant UUID AS (IF(is_default, tenant_id, NULL)) PERSISTENT INVISIBLE,
  PRIMARY KEY (id),
  UNIQUE KEY ai_providers_tenant_id_name_key (tenant_id, name),
  UNIQUE KEY ai_providers_one_default_idx (default_tenant),
  KEY ai_providers_tenant_idx (tenant_id, enabled),
  CONSTRAINT ai_providers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS master_admins (
  email VARCHAR(320) NOT NULL,
  granted_by VARCHAR(320) NOT NULL,
  note MEDIUMTEXT NOT NULL DEFAULT '',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS databricks_sync_runs (
  id UUID NOT NULL,
  dataset_id UUID,
  dataset_slug VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  mode VARCHAR(32) NOT NULL,
  source_parts INT,
  row_count BIGINT,
  file_size_bytes BIGINT,
  file_path TEXT,
  attempts INT NOT NULL DEFAULT 0,
  error_message MEDIUMTEXT,
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at DATETIME(6),
  content_sha256 VARCHAR(64),
  source_files JSON,
  effective_mode VARCHAR(32),
  PRIMARY KEY (id),
  KEY databricks_sync_runs_dataset_idx (dataset_slug, started_at DESC),
  CONSTRAINT databricks_sync_runs_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE SET NULL,
  CONSTRAINT databricks_runs_effective_mode_check CHECK (effective_mode IS NULL OR effective_mode IN ('SNAPSHOT', 'INCREMENTAL')),
  CONSTRAINT databricks_sync_runs_mode_check CHECK (mode IN ('SNAPSHOT', 'INCREMENTAL')),
  CONSTRAINT databricks_sync_runs_status_check CHECK (status IN ('SUCCESS', 'FAILED', 'SKIPPED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS alert_settings (
  tenant_id UUID NOT NULL,
  webhook_enc TEXT,
  webhook_hint VARCHAR(255),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_test_at DATETIME(6),
  last_test_ok BOOLEAN,
  last_test_error MEDIUMTEXT,
  updated_by VARCHAR(320),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id),
  CONSTRAINT alert_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS alert_events (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  "key" VARCHAR(500) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  title VARCHAR(1000) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  error MEDIUMTEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  seen_at DATETIME(6),
  seen_by VARCHAR(320),
  PRIMARY KEY (id),
  KEY alert_events_created_idx (tenant_id, created_at DESC),
  KEY alert_events_key_idx (tenant_id, "key", created_at DESC),
  KEY alert_events_unseen_idx (tenant_id, seen_at),
  CONSTRAINT alert_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT alert_events_status_check CHECK (status IN ('sent', 'failed', 'no-channel'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS reconcile_runs (
  id UUID NOT NULL DEFAULT (UUID()),
  dataset_id UUID NOT NULL,
  "trigger" VARCHAR(32) NOT NULL,
  band VARCHAR(32),
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  method VARCHAR(32),
  key_field VARCHAR(255),
  sum_field VARCHAR(255),
  window_from VARCHAR(64),
  window_to VARCHAR(64),
  source_rows BIGINT,
  lake_rows BIGINT,
  source_sum DOUBLE,
  lake_sum DOUBLE,
  days_compared INT,
  days_diverged INT,
  diff_days JSON,
  lost_rows BIGINT,
  notes JSON NOT NULL DEFAULT '[]',
  error MEDIUMTEXT,
  requested_by VARCHAR(320),
  source_ms INT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  started_at DATETIME(6),
  finished_at DATETIME(6),
  dup_identity BIGINT,
  lake_dup BIGINT,
  diagnosis MEDIUMTEXT,
  -- "uma pendente por conjunto" (índice único parcial no Postgres)
  pending_dataset UUID AS (IF(status IN ('queued', 'running'), dataset_id, NULL)) PERSISTENT INVISIBLE,
  PRIMARY KEY (id),
  UNIQUE KEY reconcile_runs_one_pending_idx (pending_dataset),
  KEY reconcile_runs_created_idx (created_at DESC),
  KEY reconcile_runs_dataset_idx (dataset_id, created_at DESC),
  CONSTRAINT reconcile_runs_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
  CONSTRAINT reconcile_runs_band_check CHECK (band IN ('small', 'medium', 'large')),
  CONSTRAINT reconcile_runs_method_check CHECK (method IN ('per-day', 'total')),
  CONSTRAINT reconcile_runs_status_check CHECK (status IN ('queued', 'running', 'match', 'diverged', 'error')),
  CONSTRAINT reconcile_runs_trigger_check CHECK ("trigger" IN ('daily', 'manual'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS dataset_checks (
  dataset_id UUID NOT NULL,
  check_name VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  detail MEDIUMTEXT,
  since DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  checked_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (dataset_id, check_name),
  KEY dataset_checks_fail_idx (status),
  CONSTRAINT dataset_checks_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
  CONSTRAINT dataset_checks_check_name_check CHECK (check_name IN ('stale', 'volume', 'identity')),
  CONSTRAINT dataset_checks_status_check CHECK (status IN ('ok', 'fail'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS usage_daily (
  tenant_id UUID NOT NULL,
  day DATE NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  resource_id UUID NOT NULL,
  actor VARCHAR(320) NOT NULL,
  via VARCHAR(32) NOT NULL,
  hits INT NOT NULL DEFAULT 1,
  first_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, day, resource_type, resource_id, actor, via),
  KEY usage_daily_resource_idx (resource_type, resource_id, day DESC),
  CONSTRAINT usage_daily_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS trash_items (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  kind VARCHAR(32) NOT NULL,
  original_id UUID NOT NULL,
  slug VARCHAR(255) NOT NULL,
  name VARCHAR(500) NOT NULL,
  owner_email VARCHAR(320),
  snapshot JSON NOT NULL,
  lake_path TEXT,
  deleted_by VARCHAR(320) NOT NULL,
  deleted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  restored_at DATETIME(6),
  restored_by VARCHAR(320),
  restored_slug VARCHAR(255),
  purged_at DATETIME(6),
  purged_by VARCHAR(320),
  PRIMARY KEY (id),
  KEY trash_items_open_idx (tenant_id, deleted_at DESC),
  CONSTRAINT trash_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT trash_items_kind_check CHECK (kind = 'dataset')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS dataset_sql_versions (
  id UUID NOT NULL DEFAULT (UUID()),
  dataset_id UUID NOT NULL,
  version INT NOT NULL,
  "sql" MEDIUMTEXT NOT NULL,
  created_by VARCHAR(320) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  note MEDIUMTEXT,
  PRIMARY KEY (id),
  UNIQUE KEY dataset_sql_versions_dataset_id_version_key (dataset_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

SET FOREIGN_KEY_CHECKS = 1;

-- As migrations 001…043 do Postgres estão contidas neste arquivo.
INSERT IGNORE INTO schema_migrations (name) VALUES
  ('001-init.sql'), ('002-catalog.sql'), ('003-sync.sql'), ('004-views.sql'), ('005-dashboards.sql'),
  ('006-ai-sharing.sql'), ('007-derived.sql'), ('008-access.sql'), ('009-official.sql'), ('010-dashboard-teams.sql'),
  ('011-sync-cadence.sql'), ('012-embeddings.sql'), ('013-sync-since.sql'), ('014-source-connections.sql'),
  ('015-http-source.sql'), ('016-api-metrics.sql'), ('017-health-checks.sql'), ('018-write-products.sql'),
  ('019-dashboard-tabs.sql'), ('020-widget-spec.sql'), ('021-api-products.sql'), ('022-api-write-ops.sql'),
  ('023-gateway.sql'), ('024-ml.sql'), ('025-notebooks.sql'), ('026-ai-providers.sql'), ('027-cascade-cadence.sql'),
  ('028-sync-schedules.sql'), ('029-incremental-upsert.sql'), ('030-compaction-visibility.sql'),
  ('031-master-admins.sql'), ('032-full-reload-marker.sql'), ('033-sync-auto-pause.sql'),
  ('034-databricks-publish.sql'), ('035-ai-message-trace.sql'), ('035-databricks-incremental.sql'),
  ('036-data-quality.sql'), ('037-dataset-checks.sql'), ('038-alert-seen.sql'), ('039-reconcile-diagnosis.sql'),
  ('040-usage.sql'), ('041-dashboard-private-default.sql'), ('042-trash.sql'), ('043-sql-versions.sql');
