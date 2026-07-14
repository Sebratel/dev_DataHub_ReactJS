-- Visualizações salvas do Explorador (docs §5): filtros/ordem/grupos/colunas
-- de um dataset, por usuário, com compartilhamento simples no tenant.

create table saved_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  dataset_id uuid not null references datasets(id) on delete cascade,
  name text not null,
  definition jsonb not null default '{}',
  owner_email text not null,
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index saved_views_dataset_idx on saved_views (dataset_id);
