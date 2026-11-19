-- Apelidos de nome de conjunto (padrão de nomes, 19/11/2026). Par da
-- migrations/046-dataset-slug-aliases.sql, onde está a explicação.
CREATE TABLE IF NOT EXISTS dataset_slug_aliases (
  tenant_id UUID NOT NULL,
  old_slug VARCHAR(191) NOT NULL,
  dataset_id UUID NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, old_slug),
  CONSTRAINT dataset_slug_aliases_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT dataset_slug_aliases_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin;

CREATE INDEX IF NOT EXISTS dataset_slug_aliases_dataset_idx ON dataset_slug_aliases (dataset_id);
