-- Fundação multi-tenant do Data Hub (docs §5 e §11).
-- Todas as tabelas carregam tenant_id; RLS entra quando houver 2º tenant real,
-- mas o modelo já nasce segregado.

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  email text not null unique,
  name text not null default '',
  picture text,
  auth_provider text not null default 'google',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_tenant_idx on users (tenant_id);

create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  builtin boolean not null default false,
  unique (tenant_id, name)
);

create table user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  primary key (user_id, role_id)
);

create table audit_logs (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  user_email text,
  action text not null,
  resource_type text,
  resource_id text,
  detail jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_logs_tenant_time_idx on audit_logs (tenant_id, created_at desc);

-- Seed: tenant Sebratel + papéis padrão.
insert into tenants (slug, name) values ('sebratel', 'Sebratel');
insert into roles (tenant_id, name, builtin)
select t.id, r.name, true
  from tenants t, (values ('admin'), ('editor'), ('viewer')) as r(name)
 where t.slug = 'sebratel';
