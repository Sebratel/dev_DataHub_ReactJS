-- ─────────────────────────────────────────────────────────────────────────
-- Modelos preditivos — o "BigQuery ML" do hub.
--
-- Dois caminhos, um registro só:
--   A) treino NO hub, em JavaScript puro (regressão logística/linear, árvore,
--      floresta) rodando num worker_thread — cobre churn, inadimplência,
--      propensão, que é o grosso da necessidade de negócio;
--   B) modelo treinado FORA e importado em ONNX — cobre XGBoost, LightGBM e
--      redes, sem trazer Python para o container.
--
-- A engenharia de atributos é SQL no DuckDB (que já é rápido nisso); o motor de
-- treino recebe uma matriz pronta. A predição em lote materializa um conjunto
-- derivado, então vira painel, métrica e API pelo encanamento que já existe.
-- ─────────────────────────────────────────────────────────────────────────

create table ml_models (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  slug text not null,
  name text not null,
  description text not null default '',

  -- 'binary' (churn, inadimplência) | 'regression' (demanda, receita)
  task text not null,
  -- 'logistic' | 'linear' | 'tree' | 'forest' | 'onnx'
  algorithm text not null,

  -- Origem dos dados: conjunto do lake + SQL de atributos. O SQL passa pelo
  -- mesmo guard dos derivados (somente leitura sobre o lake).
  dataset_slug text,
  feature_sql text,
  target_column text,
  -- Colunas ignoradas no treino (id, nome, datas soltas). Vazamento de alvo é
  -- o erro nº 1 em modelo de negócio, então isto é explícito, não adivinhado.
  excluded_columns text[] not null default '{}',

  -- Divisão treino/validação e teto de linhas (defesa de memória do worker).
  holdout_pct int not null default 20,
  max_rows int not null default 200000,
  hyperparams jsonb not null default '{}',

  -- Retreino automático junto da janela de ingestão.
  retrain text not null default 'manual',   -- 'manual' | 'daily' | 'weekly'

  owner_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index ml_models_tenant_idx on ml_models (tenant_id);

-- ── Versões ──────────────────────────────────────────────────────────────
-- Cada treino bem-sucedido gera uma versão IMUTÁVEL. Promover é trocar qual
-- delas está em produção — e dá para voltar atrás sem retreinar.
create table ml_model_versions (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references ml_models(id) on delete cascade,
  version int not null,

  -- Artefato. Modelo leve (coeficientes, árvores) cabe em JSON no banco;
  -- ONNX é grande e fica no lake, com o caminho aqui.
  artifact jsonb,
  artifact_path text,

  -- Contrato de entrada: ordem e tipo das colunas. Predizer com o schema
  -- errado devolve número plausível e silenciosamente errado — por isso é
  -- validado a cada predição, não só no treino.
  feature_schema jsonb not null,
  -- AUC, acurácia, matriz de confusão (binary); RMSE, MAE, R² (regression).
  metrics jsonb not null default '{}',
  -- Importância por atributo, quando o algoritmo expõe.
  importances jsonb,

  rows_trained int,
  rows_holdout int,
  trained_ms int,
  status text not null default 'ready',   -- 'ready' | 'promoted' | 'archived'
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (model_id, version)
);
create index ml_model_versions_model_idx on ml_model_versions (model_id, version desc);

-- Ponteiro de produção. Só UMA versão promovida por modelo.
alter table ml_models add column promoted_version_id uuid references ml_model_versions(id) on delete set null;

-- ── Execuções de treino ──────────────────────────────────────────────────
-- Mesma forma de sync_runs, para a tela de acompanhamento ser a mesma história.
create table ml_training_runs (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references ml_models(id) on delete cascade,
  version_id uuid references ml_model_versions(id) on delete set null,
  status text not null default 'running',  -- 'running' | 'done' | 'error' | 'canceled'
  trigger text not null default 'manual',  -- 'manual' | 'schedule'
  rows int,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index ml_training_runs_model_idx on ml_training_runs (model_id, started_at desc);

-- ── Monitoramento de deriva ──────────────────────────────────────────────
-- Um modelo não avisa que envelheceu: ele continua respondendo, só que errado.
-- Aqui guardamos a distribuição das predições ao longo do tempo e, quando o
-- resultado real chega, a métrica recalculada sobre ele.
create table ml_drift_checks (
  id bigserial primary key,
  model_id uuid not null references ml_models(id) on delete cascade,
  version_id uuid references ml_model_versions(id) on delete set null,
  checked_at timestamptz not null default now(),
  rows_scored int,
  -- Média/desvio das predições e, quando disponível, a métrica sobre dados
  -- reais recentes — é a queda dela que dispara o alerta.
  prediction_stats jsonb not null default '{}',
  live_metrics jsonb,
  drift_score numeric,
  alert boolean not null default false
);
create index ml_drift_checks_model_idx on ml_drift_checks (model_id, checked_at desc);
