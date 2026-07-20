-- Sprint 8: unifica o compartilhamento de dashboards no mesmo modelo dos
-- conjuntos — concessão a um TIME ou a uma PESSOA. Antes só havia por e-mail.
-- Grants existentes (por e-mail) continuam válidos; team_id fica nulo neles.
alter table dashboard_grants add column team_id uuid references teams(id) on delete cascade;
alter table dashboard_grants alter column grantee_email drop not null;

-- Exatamente um alvo por concessão (time XOR e-mail).
alter table dashboard_grants
  add constraint dashboard_grants_target_chk check ((team_id is not null) <> (grantee_email is not null));

-- Uma concessão por (dashboard, time). O unique (dashboard_id, grantee_email)
-- que já existia continua cuidando das concessões por e-mail (NULL é distinto).
create unique index dashboard_grants_uq_team on dashboard_grants (dashboard_id, team_id) where team_id is not null;
