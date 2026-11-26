-- Correção automática da madrugada (26/11/2026): o "Corrigir" da tela
-- Qualidade dos dados — recarga completa + conferência — pedido pela rotina,
-- até 3 pequenos, 2 médios e 1 grande por noite (modules/quality/autofix.ts).
-- A conferência que ela pede ganha a origem própria 'autofix': é por ela que a
-- rotina sabe que já tentou um conjunto nos últimos 7 dias, e é o que a tela
-- mostra como "correção automática".
alter table reconcile_runs drop constraint if exists reconcile_runs_trigger_check;
alter table reconcile_runs add constraint reconcile_runs_trigger_check
  check (trigger in ('daily', 'manual', 'autofix'));
