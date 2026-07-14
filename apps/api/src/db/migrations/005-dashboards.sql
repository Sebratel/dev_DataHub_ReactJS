-- Biblioteca de métricas + dashboards e widgets (docs §5).

create table metrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  dataset_id uuid not null references datasets(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null default '',
  agg text not null,                        -- sum|avg|min|max|count|count_distinct
  field_key text not null,                  -- campo do dataset (key exposta)
  filters jsonb not null default '[]',      -- QueryFilter[] embutidos na métrica
  format text not null default 'number',    -- number | currency | percent
  owner_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index metrics_dataset_idx on metrics (dataset_id);

create table dashboards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  description text not null default '',
  owner_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index dashboards_tenant_idx on dashboards (tenant_id);

create table widgets (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references dashboards(id) on delete cascade,
  dataset_id uuid not null references datasets(id) on delete cascade,
  title text not null default '',
  type text not null,                       -- kpi|line|bar|pie|area|table
  dimension text,                           -- campo do eixo/categoria (null p/ kpi)
  metric jsonb not null,                    -- {"metric":"slug"} ou {"field":"...","agg":"sum"}
  filters jsonb not null default '[]',
  size text not null default 'md',          -- sm | md | lg
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index widgets_dashboard_idx on widgets (dashboard_id, sort_order);
