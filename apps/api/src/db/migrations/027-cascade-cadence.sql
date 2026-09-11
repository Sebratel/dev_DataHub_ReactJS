-- Cadência 'cascade': o conjunto DERIVADO recalcula sozinho assim que QUALQUER
-- fonte ou derivado que ele referencia termina uma sincronização com sucesso —
-- em vez de esperar o relógio (hourly/daily) bater, que podia deixá-lo até 24h
-- desatualizado mesmo com a fonte já renovada.
--
-- Só faz sentido para 'derived' (quem tem transform_sql para checar
-- dependência); a UI só oferece esta opção nesse caso, mas a constraint não
-- proíbe por completo — datasets.kind já é a fonte de verdade sobre o que tem
-- dependência para cascatear.
alter table datasets drop constraint datasets_sync_cadence_check,
  add constraint datasets_sync_cadence_check check (sync_cadence in ('daily', 'hourly', 'manual', 'cascade'));
