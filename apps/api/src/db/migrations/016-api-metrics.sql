-- Observabilidade das APIs (Fase 2). Cada chamada HTTP na ingestão registra uma
-- linha aqui: latência, status, bytes, linhas. Fica no banco de metadados, então
-- pode ser PUBLICADA como dataset via o conector "Metadados do Hub" e analisada
-- com dashboards/métricas/IA (latência p95, throughput, taxa de erro).
create table api_call_metrics (
  id bigserial primary key,
  dataset_slug text,       -- qual conjunto de API gerou a chamada
  connection_id text,      -- qual conexão HTTP
  endpoint text,           -- caminho do endpoint (estável, p/ agrupar)
  status int,              -- código HTTP
  ok boolean not null,     -- 2xx/3xx
  duration_ms int,         -- latência da chamada
  rows int,                -- registros retornados na página
  bytes bigint,            -- tamanho da resposta
  error text,
  created_at timestamptz not null default now()
);
create index api_call_metrics_created_idx on api_call_metrics (created_at desc);
create index api_call_metrics_dataset_idx on api_call_metrics (dataset_slug, created_at desc);
