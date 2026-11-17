-- Totais da IA que sobrevivem às conversas (D-MON-4). Par da
-- migrations/045-ai-usage-totals.sql, onde está a explicação.
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  tenant_id UUID NOT NULL,
  day DATE NOT NULL,
  user_email VARCHAR(320) NOT NULL,
  conversations INT NOT NULL DEFAULT 0,
  questions INT NOT NULL DEFAULT 0,
  answers INT NOT NULL DEFAULT 0,
  tool_calls INT NOT NULL DEFAULT 0,
  tool_errors INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, user_email),
  CONSTRAINT ai_usage_daily_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations (updated_at);
