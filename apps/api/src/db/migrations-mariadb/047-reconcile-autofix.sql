-- Correção automática da madrugada (26/11/2026). Par da
-- migrations/047-reconcile-autofix.sql, onde está a explicação.
ALTER TABLE reconcile_runs DROP CONSTRAINT IF EXISTS reconcile_runs_trigger_check;
ALTER TABLE reconcile_runs ADD CONSTRAINT reconcile_runs_trigger_check
  CHECK ("trigger" IN ('daily', 'manual', 'autofix'));
