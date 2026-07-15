-- Sprint 6: chat IA, compartilhamento de dashboards e tokens de integração.

create table conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_email text not null,
  title text not null default 'Nova conversa',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_idx on conversations (tenant_id, user_email, updated_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null,                -- user | assistant
  content text not null default '',
  chart jsonb,                       -- widget-like def gerado pela tool render_chart
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on messages (conversation_id, created_at);

-- Compartilhamento de dashboards: 'tenant' (todos veem, comportamento atual)
-- ou 'private' (só dono + convidados via grants).
alter table dashboards add column visibility text not null default 'tenant';

create table dashboard_grants (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references dashboards(id) on delete cascade,
  grantee_email text not null,
  level text not null default 'view',  -- view | edit
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (dashboard_id, grantee_email)
);

-- Tokens de integração (Power BI, Sheets, API REST). Hash do token, nunca o valor.
create table api_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  token_hash text not null unique,
  dataset_slugs text[] not null default '{}',  -- vazio = todos os datasets do tenant
  owner_email text not null,
  revoked boolean not null default false,
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
