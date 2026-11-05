-- ─────────────────────────────────────────────────────────────────────────
-- Alertas vistos DENTRO do sistema.
--
-- A tela "Saúde da plataforma" passa a ser o canal principal: o admin abre o
-- Data Hub e vê o que aconteceu, sem depender de e-mail nem de chat (o
-- webhook continua existindo, mas é opcional). Para um canal dentro do
-- sistema funcionar, ele precisa distinguir o que é novo do que alguém já
-- viu — senão o sino no cabeçalho conta para sempre os mesmos avisos.
--
-- "Visto" é do tenant, não de cada pessoa: os admins são um time pequeno que
-- divide a mesma fila de problemas, e quem marcou fica registrado.
-- ─────────────────────────────────────────────────────────────────────────

alter table alert_events
  add column seen_at timestamptz,
  add column seen_by text;

create index alert_events_unseen_idx on alert_events (tenant_id) where seen_at is null;

-- "Cargas das últimas 24 h" de TODOS os conjuntos (MON-08): o índice que já
-- existe começa pelo conjunto e não serve para um corte só por tempo. Com
-- agendamentos de 5 em 5 min a tabela cresce centenas de linhas por dia.
create index sync_runs_started_idx on sync_runs (started_at desc);
