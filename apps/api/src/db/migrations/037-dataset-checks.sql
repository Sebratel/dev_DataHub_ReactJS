-- ─────────────────────────────────────────────────────────────────────────
-- Verificações contínuas por conjunto (D-QLD-2, opção A — R4 de 30/10/2026).
--
-- A conciliação (036) confere a fonte, mas um conjunto por faixa por dia: um
-- defeito pode esperar semanas pela vez dele. Estas verificações rodam o
-- tempo todo e olham SÓ o lake e o catálogo, sem tocar na fonte:
--   • 'stale'    — prazo pela cadência: um conjunto de hora em hora parado há
--                  3 h aparecia "em dia" até completar 26 h (MON-09, QLD-10);
--   • 'volume'   — snapshot que encolheu de repente: uma página perdida no
--                  OFFSET substitui a cópia completa sem erro nenhum (QLD-08);
--   • 'identity' — identidade vazia ou repetida no lake: a compactação junta
--                  todas as linhas de identidade vazia numa só (QLD-04).
--
-- Guarda o ESTADO atual, não o histórico: uma linha por conjunto e
-- verificação. O alerta sai na troca de estado (passou a falhar, voltou ao
-- normal) — gravar cada execução encheria a tabela com centenas de "ok" por
-- dia, e o que importa saber é desde quando algo está errado.
-- ─────────────────────────────────────────────────────────────────────────

create table dataset_checks (
  dataset_id uuid not null references datasets(id) on delete cascade,
  check_name text not null check (check_name in ('stale', 'volume', 'identity')),
  status text not null check (status in ('ok', 'fail')),
  detail text,
  -- Desde quando está NESTE estado: muda só quando o estado muda.
  since timestamptz not null default now(),
  checked_at timestamptz not null default now(),
  primary key (dataset_id, check_name)
);
create index dataset_checks_fail_idx on dataset_checks (status) where status = 'fail';

-- Na conciliação: quantas linhas da fonte, na janela conferida, a mais do que
-- identidades distintas. Acima de zero, a identidade configurada não é única
-- na fonte, e a compactação guarda só uma de cada — é a pergunta da QLD-04
-- ("a identidade de cada conjunto é única de verdade?") respondida com dado.
alter table reconcile_runs add column dup_identity bigint;
