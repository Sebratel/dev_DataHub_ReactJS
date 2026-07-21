-- Sprint 8: cadência de sincronização POR CONJUNTO. Antes o agendador rodava
-- todos na janela diária; agora cada conjunto escolhe a frequência.
--   daily  → uma vez por dia, na janela ETL_HOUR (comportamento padrão anterior)
--   hourly → a cada hora cheia
--   manual → nunca automático (só sob demanda pelo admin)
alter table datasets add column sync_cadence text not null default 'daily';
alter table datasets add constraint datasets_sync_cadence_check
  check (sync_cadence in ('daily', 'hourly', 'manual'));
