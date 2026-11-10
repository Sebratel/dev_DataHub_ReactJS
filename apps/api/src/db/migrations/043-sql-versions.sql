-- ─────────────────────────────────────────────────────────────────────────
-- Versões do SQL dos calculados (achado DSP-03 do comitê).
--
-- O dono reescrevia o SQL de um calculado OFICIAL, o selo continuava e o SQL
-- anterior se perdia: o número que a diretoria tinha chancelado mudava de
-- definição sem ninguém aprovar e sem dar para ver o que era antes.
--
-- Agora o SQL de um oficial só muda por admin (no código da rota), e TODA
-- gravação de SQL de calculado, oficial ou não, vira uma versão aqui. Dá para
-- comparar e restaurar uma versão anterior.
--
-- O processo formal de aprovação (quem aprova, com que prazo) é a D-QLD-1,
-- remarcada para a R6. Até lá a regra é a mais simples que fecha o achado:
-- oficial congela, admin altera, nada se perde.
--
-- Sem chave estrangeira de propósito, como o uso (040): o histórico sobrevive
-- à lixeira, e um calculado restaurado (mesmo id) reencontra as versões.
-- ─────────────────────────────────────────────────────────────────────────
create table dataset_sql_versions (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null,
  version int not null,
  sql text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  note text,
  unique (dataset_id, version)
);

-- O que está em vigor hoje vira a versão 1 de cada calculado.
insert into dataset_sql_versions (dataset_id, version, sql, created_by, note)
select id, 1, transform_sql, coalesce(owner_email, 'sistema'),
       'SQL em vigor quando o histórico de versões começou.'
  from datasets
 where kind = 'derived' and transform_sql is not null;
