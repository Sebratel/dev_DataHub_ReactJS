-- ─────────────────────────────────────────────────────────────────────────
-- Notebooks: análise rápida sobre o lake, no estilo dos notebooks do BigQuery.
--
-- Células em JSONB, não em tabela própria: a ordem importa, elas são editadas
-- em bloco e nunca são consultadas individualmente por SQL. Uma tabela
-- `notebook_cells` só traria join e controle de ordenação sem nenhum ganho.
--
-- As SAÍDAS não são guardadas por padrão. Resultado de consulta envelhece
-- (e pode conter dado sensível de um conjunto ao qual quem abrir o notebook
-- depois não tem acesso). Guardar o SQL e reexecutar é mais barato e mais
-- seguro do que guardar linhas.
-- ─────────────────────────────────────────────────────────────────────────

create table notebooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  slug text not null,
  name text not null,
  description text not null default '',

  -- [{ id, kind: 'sql'|'markdown'|'python', source, name? }]
  cells jsonb not null default '[]',

  -- Mesmo modelo de compartilhamento dos conjuntos e painéis.
  visibility text not null default 'private',  -- 'private' | 'tenant'
  owner_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index notebooks_tenant_idx on notebooks (tenant_id, updated_at desc);
create index notebooks_owner_idx on notebooks (owner_email);

-- Concessões por e-mail ou por time — espelha dataset_grants para o
-- compartilhamento ser a mesma história em toda a plataforma.
create table notebook_grants (
  notebook_id uuid not null references notebooks(id) on delete cascade,
  grantee_email text,
  team_id uuid references teams(id) on delete cascade,
  can_edit boolean not null default false,
  created_at timestamptz not null default now(),
  check (grantee_email is not null or team_id is not null)
);
create unique index notebook_grants_email_idx
  on notebook_grants (notebook_id, grantee_email) where grantee_email is not null;
create unique index notebook_grants_team_idx
  on notebook_grants (notebook_id, team_id) where team_id is not null;
