-- Fase 4: PRODUTOS DE ESCRITA (API platform). Admin define um endpoint público
-- que faz um INSERT parametrizado numa CONEXÃO GRAVÁVEL (banco interno). O
-- consumidor manda só os VALORES (nunca SQL/coluna) → à prova de injection.
-- Fluxo separado do read-only: só estas definições podem escrever.

-- Marca conexões que podem receber escrita (credencial com permissão de INSERT).
alter table source_connections add column writable boolean not null default false;

-- Tokens: além de dataset_slugs (leitura), quais PRODUTOS de escrita podem chamar.
-- Escrita nunca é default — precisa listar explicitamente.
alter table api_credentials add column write_slugs text[] not null default '{}';

create table api_write_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  slug text not null,               -- vira POST /api/public/v1/w/<slug>
  name text not null,
  connection_id text not null,      -- deve ser uma conexão writable
  schema_name text not null,
  table_name text not null,
  -- [{ "col": "...", "type": "text|number|bool|date", "required": bool }]
  columns jsonb not null,
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index api_write_products_tenant_idx on api_write_products (tenant_id);
