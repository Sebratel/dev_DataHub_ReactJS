-- Fase 3: HEALTH CHECKS (uptime). Pinga endpoints periodicamente e registra a
-- latência/status em api_call_metrics (as mesmas métricas da ingestão), então
-- aparece no MESMO painel "Saúde das APIs". check_type distingue a origem.
alter table api_call_metrics add column check_type text not null default 'sync'; -- 'sync' | 'healthcheck'

create table health_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  url text not null,                 -- URL completa a monitorar
  connection_id text,                -- conexão HTTP p/ reaproveitar auth (opcional)
  interval_minutes int not null default 5,
  enabled boolean not null default true,
  last_run_at timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
create index health_checks_tenant_idx on health_checks (tenant_id);
