-- ─────────────────────────────────────────────────────────────────────────
-- Gateway de APIs — plano de dados.
--
-- Até aqui o hub PUBLICAVA APIs que ele mesmo gerava a partir de conjuntos e
-- tabelas. Esta migração acrescenta o que faltava para ser gateway de verdade:
--   1. upstreams  — APIs internas que JÁ EXISTEM entram atrás do gateway
--   2. política   — quota e rate limit por consumidor (antes: nada, nenhum 429)
--   3. atribuição — telemetria por credencial, não por nome de token em texto
--
-- Sobre (3): a telemetria de entrada vinha gravando o NOME do token na coluna
-- `connection_id`, que na origem significa "qual conexão HTTP de ingestão".
-- Funcionava, mas renomear um token quebrava o histórico e dois tokens de mesmo
-- nome se fundiam. Agora existe credential_id com FK. A coluna antiga fica
-- (histórico) e o código novo escreve nas duas durante a transição.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Upstreams: serviços internos atrás do gateway ─────────────────────
create table gateway_upstreams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  slug text not null,                  -- prefixo público: /api/public/v1/gw/<slug>/…
  name text not null,
  description text not null default '',
  base_url text not null,              -- destino interno (http/https)

  -- Credencial DO UPSTREAM. O consumidor nunca a vê: o gateway a injeta.
  -- Segredo cifrado em repouso (AES-256-GCM, core/crypto).
  auth_mode text not null default 'none',   -- 'none' | 'bearer' | 'header' | 'basic'
  auth_header text,                         -- nome do header quando auth_mode='header'
  auth_secret_enc text,

  -- Política do upstream
  methods text[] not null default '{GET}',  -- métodos permitidos (allowlist)
  timeout_ms int not null default 15000,
  strip_prefix boolean not null default true, -- remove /gw/<slug> antes de repassar
  forward_headers text[] not null default '{}', -- headers do cliente repassados além do safelist

  -- Mesmo fluxo de aprovação dos produtos de API: dev cria, admin aprova.
  status text not null default 'pending',   -- 'pending' | 'active' | 'rejected'
  enabled boolean not null default true,
  owner_email text not null,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index gateway_upstreams_tenant_idx on gateway_upstreams (tenant_id, status);

-- ── 2. Política por consumidor ───────────────────────────────────────────
-- NULL = sem limite (comportamento de hoje, para nenhum token existente
-- quebrar). Os limites entram por token, na tela de Integrações.
alter table api_credentials add column rate_limit_per_min int;
alter table api_credentials add column quota_per_day int;
-- Escopo de upstreams, no mesmo espírito de dataset_slugs: vazio = nenhum
-- (upstream é opt-in explícito — diferente de dataset, onde vazio = todos).
alter table api_credentials add column upstream_slugs text[] not null default '{}';

-- Consumo diário DURÁVEL. O rate limit por minuto vive em memória (rápido,
-- reinicia junto com o processo); a quota diária precisa sobreviver a restart,
-- senão um redeploy zera o teto de todo mundo.
create table api_usage_daily (
  credential_id uuid not null references api_credentials(id) on delete cascade,
  day date not null,
  calls int not null default 0,
  primary key (credential_id, day)
);
create index api_usage_daily_day_idx on api_usage_daily (day desc);

-- ── 3. Telemetria de gateway ─────────────────────────────────────────────
alter table api_call_metrics add column credential_id uuid references api_credentials(id) on delete set null;
alter table api_call_metrics add column request_id text;
alter table api_call_metrics add column method text;
alter table api_call_metrics add column upstream_slug text;
-- Latência do UPSTREAM separada da total: sem isso não dá para responder
-- "a lentidão é minha ou do serviço de trás?".
alter table api_call_metrics add column upstream_ms int;
alter table api_call_metrics add column consumer_ip text;

create index api_call_metrics_credential_idx on api_call_metrics (credential_id, created_at desc);
create index api_call_metrics_upstream_idx on api_call_metrics (upstream_slug, created_at desc);

comment on column api_call_metrics.check_type is
  'origem da linha: sync (ingestão) | healthcheck | public (API gerada) | gateway (proxy de upstream)';
