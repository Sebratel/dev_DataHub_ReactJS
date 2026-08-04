-- Construtor de APIs (self-service do dev): produtos de API UNIFICADOS —
-- leitura (GET, paginação page/offset + filtros) e escrita (POST, body = colunas).
-- Escrita passa por APROVAÇÃO do admin (status pending → active). Substitui o
-- api_write_products (os produtos existentes migram como 'write' já aprovados).
create table api_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  slug text not null,
  name text not null,
  kind text not null,                 -- 'read' | 'write'
  method text not null,               -- 'GET' | 'POST'
  owner_email text not null,          -- dev que criou
  status text not null default 'active', -- 'active' | 'pending' | 'rejected'
  enabled boolean not null default true,
  -- Leitura (kind='read')
  dataset_slug text,
  pagination text,                    -- 'page' | 'offset'
  default_limit int,
  max_limit int,
  read_filters jsonb,                 -- QueryFilter[] fixos aplicados sempre
  -- Escrita (kind='write')
  connection_id text,
  schema_name text,
  table_name text,
  columns jsonb,                      -- [{ col, type, required }]
  -- Auditoria da aprovação
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index api_products_tenant_idx on api_products (tenant_id);
create index api_products_status_idx on api_products (tenant_id, status);

-- Migra os produtos de escrita existentes: todos já eram criados por admin →
-- entram como 'write' ATIVOS (aprovados), preservando slug (tokens apontam pra ele).
insert into api_products
  (tenant_id, slug, name, kind, method, owner_email, status, enabled,
   connection_id, schema_name, table_name, columns, created_at)
select
  tenant_id, slug, name, 'write', 'POST', coalesce(created_by, 'sistema@datahub'), 'active', enabled,
  connection_id, schema_name, table_name, columns, created_at
from api_write_products;
