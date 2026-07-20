-- Sprint 8: Controle de acesso por TIME. "Fechado por padrão": conjunto novo
-- nasce privado (visibility='private') e só é visível a admin, ao dono e a
-- quem receber concessão — via time ou por e-mail. Conjuntos JÁ existentes
-- mantêm 'tenant' (visíveis a todos) e não perdem acesso na migração.

-- Times (grupos de usuários) — conceder acesso em bloco aos "clientes internos".
create table teams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  slug text not null,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index teams_tenant_idx on teams (tenant_id);

create table team_members (
  team_id uuid not null references teams(id) on delete cascade,
  user_email text not null,
  created_at timestamptz not null default now(),
  primary key (team_id, user_email)
);
create index team_members_email_idx on team_members (user_email);

-- Concessão de dataset: a um TIME ou a uma PESSOA (exatamente um dos dois).
-- can_export: ler é sempre permitido pela concessão; exportar é opcional.
create table dataset_grants (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  team_id uuid references teams(id) on delete cascade,
  grantee_email text,
  can_export boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  check ((team_id is not null) <> (grantee_email is not null))
);
create index dataset_grants_dataset_idx on dataset_grants (dataset_id);
create index dataset_grants_email_idx on dataset_grants (grantee_email) where grantee_email is not null;
-- Uma concessão por (dataset, alvo) — evita duplicar/empilhar grants.
create unique index dataset_grants_uq_team on dataset_grants (dataset_id, team_id) where team_id is not null;
create unique index dataset_grants_uq_email on dataset_grants (dataset_id, grantee_email) where grantee_email is not null;

-- Postura fechada para o futuro: conjuntos criados a partir de agora nascem
-- privados. Os existentes seguem com o valor que já têm ('tenant').
alter table datasets alter column visibility set default 'private';
