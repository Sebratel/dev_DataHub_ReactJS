-- Catálogo: datasets publicados (visão amigável) e seus campos (docs §5).
-- O usuário final nunca vê schema/tabela física — só name/label/description.

create table datasets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Origem física (id do conector no código + objeto). Visível só para admins.
  connection_id text not null,
  schema_name text not null,
  object_name text not null,
  slug text not null,
  name text not null,
  description text not null default '',
  tags text[] not null default '{}',
  owner_email text,
  visibility text not null default 'tenant',   -- tenant | private
  sync_mode text not null default 'live',      -- live | snapshot | incremental (lake: Sprint 3)
  incremental_key text,
  row_count bigint,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug),
  unique (tenant_id, connection_id, schema_name, object_name)
);
create index datasets_tenant_idx on datasets (tenant_id);

create table dataset_fields (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  source_column text not null,                 -- coluna física (nunca exposta)
  key text not null,                           -- nome exposto na API/UI
  label text not null,
  description text,
  type text not null default 'text',           -- text|number|date|bool|json
  hidden boolean not null default false,       -- nunca sai da API
  sensitive boolean not null default false,    -- mascarado sem permissão export
  sort_order int not null default 0,
  unique (dataset_id, source_column),
  unique (dataset_id, key)
);
create index dataset_fields_dataset_idx on dataset_fields (dataset_id);
