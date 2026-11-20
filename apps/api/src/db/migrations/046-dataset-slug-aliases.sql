-- Padrão de nomes dos conjuntos (19/11/2026): <camada>_<área>_<assunto>,
-- minúsculas com sublinhado. Renomear um conjunto não pode quebrar quem já
-- usa o nome antigo — link salvo, integração com token, SQL de calculado,
-- notebook ou modelo. O nome antigo fica aqui como APELIDO do conjunto:
-- a URL com ele é redirecionada para o nome novo, e o SQL que o cita continua
-- lendo o mesmo Parquet. Ver modules/catalog/naming.ts.
create table dataset_slug_aliases (
  tenant_id uuid not null references tenants(id) on delete cascade,
  old_slug text not null,
  dataset_id uuid not null references datasets(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tenant_id, old_slug)
);

create index dataset_slug_aliases_dataset_idx on dataset_slug_aliases (dataset_id);
