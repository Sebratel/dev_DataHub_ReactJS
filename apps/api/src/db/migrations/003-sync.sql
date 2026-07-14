-- Sincronização com o lake: histórico de execuções + watermark incremental.

alter table datasets add column watermark text;

create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  mode text not null,                          -- snapshot | incremental
  status text not null default 'running',     -- running | done | error
  rows bigint not null default 0,
  bytes bigint not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index sync_runs_dataset_idx on sync_runs (dataset_id, started_at desc);
