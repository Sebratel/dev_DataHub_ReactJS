-- ─────────────────────────────────────────────────────────────────────────
-- Totais da IA que sobrevivem às conversas (D-MON-4, decidido na R6 de 13/11).
--
-- A conversa com a IA (pergunta, resposta, gráficos e rastro) é apagada 30
-- dias depois da última mensagem; os totais ficam. Antes de apagar, cada
-- conversa é somada aqui, por dia (no fuso daqui), por pessoa — inclusive
-- quando a própria pessoa apaga a conversa pela tela. Nada do conteúdo entra:
-- só contagens.
--
--   conversations: conversas com mensagem naquele dia;
--   questions / answers: mensagens da pessoa / da IA;
--   tool_calls / tool_errors: consultas que a IA fez, e quantas deram erro.
-- ─────────────────────────────────────────────────────────────────────────
create table ai_usage_daily (
  tenant_id uuid not null references tenants(id),
  day date not null,
  user_email text not null,
  conversations int not null default 0,
  questions int not null default 0,
  answers int not null default 0,
  tool_calls int not null default 0,
  tool_errors int not null default 0,
  primary key (tenant_id, day, user_email)
);

-- A rotina diária procura as conversas paradas há mais de 30 dias.
create index conversations_updated_idx on conversations (updated_at);
