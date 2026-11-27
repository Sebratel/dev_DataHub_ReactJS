-- ─────────────────────────────────────────────────────────────────────────
-- Assistente IA: o que se ensina a ele e como se mede (pedido de 27/11/2026).
--
-- ai_dataset_notes — o que uma pessoa ensinou sobre UM conjunto (para que
--   serve, o que cada linha é, armadilhas, como se calcula o indicador). Soma
--   ao conhecimento que vem do código (regras do Voalle por tabela de origem,
--   descrição dos pacotes) e ao perfil automático (valores, nulos, faixas),
--   que valem sozinhos para qualquer conjunto novo. Edita: admin ou o dono do
--   conjunto. Uma linha por conjunto; some junto com ele.
--
-- ai_eval_runs — cada rodada da avaliação do assistente: as perguntas de
--   referência, o que ele respondeu, o número certo (calculado na hora, sobre
--   o mesmo lake) e se bateu. É o que diz se uma mudança melhorou ou piorou.
-- ─────────────────────────────────────────────────────────────────────────
create table ai_dataset_notes (
  dataset_id uuid primary key references datasets(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  notes text not null default '',
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create table ai_eval_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  started_by text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  provider text,
  model text,
  total int not null default 0,
  passed int not null default 0,
  skipped int not null default 0,
  results jsonb,
  error text
);
create index ai_eval_runs_tenant_idx on ai_eval_runs (tenant_id, started_at desc);
