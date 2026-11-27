-- Assistente IA: notas por conjunto e rodadas da avaliação. Par da
-- migrations/048-ai-conhecimento-avaliacao.sql, onde está a explicação.
CREATE TABLE IF NOT EXISTS ai_dataset_notes (
  dataset_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  notes LONGTEXT NOT NULL DEFAULT '',
  updated_by VARCHAR(320) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (dataset_id),
  CONSTRAINT ai_dataset_notes_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
  CONSTRAINT ai_dataset_notes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE TABLE IF NOT EXISTS ai_eval_runs (
  id UUID NOT NULL DEFAULT (UUID()),
  tenant_id UUID NOT NULL,
  started_by VARCHAR(320) NOT NULL,
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at DATETIME(6),
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  provider VARCHAR(64),
  model VARCHAR(200),
  total INT NOT NULL DEFAULT 0,
  passed INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  results JSON,
  error LONGTEXT,
  PRIMARY KEY (id),
  KEY ai_eval_runs_tenant_idx (tenant_id, started_at),
  CONSTRAINT ai_eval_runs_status_check CHECK (status IN ('running', 'done', 'error')),
  CONSTRAINT ai_eval_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;
