-- Agendamento de sincronização: janela de horário + dia da semana + intervalo
-- em minutos, como uma politica NOMEADA e REUTILIZAVEL aplicada a varios
-- conjuntos de uma vez (em vez de repetir os mesmos 4 campos dataset a
-- dataset). Editar o agendamento propaga para todo mundo que o usa.
create table sync_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  interval_minutes int not null check (interval_minutes between 1 and 1440),
  start_time text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time text not null check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- bitmask: bit 0 = domingo .. bit 6 = sabado (Date.getDay() no servidor).
  -- >= 1 exige pelo menos um dia marcado -- um agendamento sem dia nenhum
  -- nunca dispararia e so confundiria quem olhasse a lista.
  weekdays smallint not null check (weekdays between 1 and 127),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sync_schedules_tenant_idx on sync_schedules (tenant_id);

alter table datasets add column schedule_id uuid references sync_schedules(id) on delete set null;

-- 'schedule' é a quinta cadência: o dataset segue a janela/intervalo do
-- agendamento em vez do proprio relogio fixo (hourly/daily).
alter table datasets drop constraint datasets_sync_cadence_check,
  add constraint datasets_sync_cadence_check check (sync_cadence in ('daily', 'hourly', 'manual', 'cascade', 'schedule'));

-- Mesmo espirito do pareamento sync_mode='incremental' <-> incremental_key:
-- 'schedule' sem schedule_id (ou vice-versa) é estado inconsistente que não
-- deveria existir no banco.
alter table datasets add constraint datasets_schedule_pairing_check
  check ((sync_cadence = 'schedule') = (schedule_id is not null));
