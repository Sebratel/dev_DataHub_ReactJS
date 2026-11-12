-- ─────────────────────────────────────────────────────────────────────────
-- Lixeira de conjuntos (D-DSP-3; achados DSP-01 e DSP-07 do comitê).
--
-- Excluir um conjunto era definitivo e em cascata: as métricas sobre ele e os
-- widgets dos painéis sumiam junto, sem aviso, e os Parquet eram apagados na
-- hora. E só admin excluía — o editor criava calculados e não conseguia limpar
-- os próprios.
--
-- Agora:
--   • excluir LISTA os dependentes (métrica, painel, calculado, API, modelo,
--     token) e RECUSA enquanto houver algum;
--   • sem dependentes, o conjunto vai para a lixeira: a definição inteira
--     (conjunto, campos, concessões, visões salvas) fica guardada aqui e os
--     Parquet esperam em <lake>/.lixeira/<tenant>/<id do item>;
--   • restaura por 30 dias; depois disso, ou quando um admin manda "excluir de
--     vez", os Parquet são apagados e o item fica marcado como `purged_at`.
--
-- A linha da lixeira NUNCA é apagada: depois de restaurado ou excluído de vez,
-- ela continua como registro do que existiu, de quem excluiu e quando.
--
-- Por que guardar a definição aqui, em vez de uma coluna "excluído" em
-- datasets: o catálogo é lido em quase cem lugares (agendador, IA, qualidade,
-- painéis, API pública...). Um conjunto excluído que continuasse em datasets
-- teria de ser filtrado em cada um deles, e o filtro esquecido num só faria a
-- lixeira continuar sincronizando com a fonte.
-- ─────────────────────────────────────────────────────────────────────────
create table trash_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('dataset')),
  original_id uuid not null,
  slug text not null,
  name text not null,
  owner_email text,
  -- { dataset, fields, grants, views }: as linhas como estavam na exclusão.
  snapshot jsonb not null,
  -- Onde os Parquet esperam, relativo à raiz do lake. Nulo = não havia dado.
  lake_path text,
  deleted_by text not null,
  deleted_at timestamptz not null default now(),
  restored_at timestamptz,
  restored_by text,
  restored_slug text,
  purged_at timestamptz,
  purged_by text
);

-- A tela lista o que ainda está na lixeira; o prazo varre pelo mesmo índice.
create index trash_items_open_idx on trash_items (tenant_id, deleted_at desc)
  where restored_at is null and purged_at is null;
