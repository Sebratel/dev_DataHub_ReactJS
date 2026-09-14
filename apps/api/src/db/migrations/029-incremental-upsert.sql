-- Incremental que ATUALIZA a linha em vez de duplicá-la, com duas chaves e
-- piso relativo. Três problemas de uma vez:
--
-- 1. UMA chave só. Com incremental_key = 'modified', toda linha SEM modified é
--    descartada em silêncio — em SQL, NULL > x nunca é verdadeiro — e na maioria
--    das tabelas o modified só existe quando houve edição. Com 'created',
--    nenhuma edição volta. Não havia como pegar os dois: a tela obrigava a
--    escolher entre o que foi criado e o que foi modificado.
--
-- 2. Sem identidade de linha, uma linha reeditada vira DUAS linhas no lake: o
--    incremental acrescenta um Parquet novo (replaceParts = false) e ninguém
--    remove a versão anterior — não existe dedup em nenhum caminho de leitura,
--    nem na consulta, nem no derivado. Com cadência de 5 em 5 minutos isso
--    acumula até 288x por dia, e o row_count conta todas as versões.
--
-- 3. sync_since é data FIXA. "Tudo que foi criado ou editado hoje" não era
--    expressável: a cada mudança de período alguém teria que reeditar a data à
--    mão, e mudar o piso zera o watermark (recarga do zero).
--
-- DESENHO: duas PASSADAS keyset (uma por chave, cada uma com seu watermark), e
-- não uma expressão greatest(created, modified) na consulta à fonte. A
-- expressão mataria o índice e viraria varredura completa da tabela a cada
-- lote, contra a produção, a cada 5 minutos. Cada passada ordena pela SUA
-- coluna e continua usando o índice dela.
--
-- As passadas se sobrepõem de propósito (linha criada E editada na janela vem
-- nas duas), e a folga de reconferência repete de propósito. Quem resolve a
-- repetição é a compactação por dedupe_keys — por isso a 2ª chave só pode ser
-- configurada DEPOIS da identidade, garantido por constraint abaixo: sem ela,
-- duas passadas duplicariam linha com certeza.
alter table datasets
  add column incremental_key_2 text,
  add column watermark_2 text,
  -- Identidade da linha (1+ campos expostos). Vazio = comportamento de hoje,
  -- só-acrescenta. Preenchido = upsert: a versão mais recente vence.
  add column dedupe_keys text[] not null default '{}',
  -- Piso RELATIVO da 1ª carga, em dias — alternativa ao sync_since fixo.
  add column sync_since_days int,
  -- Folga de reconferência: em vez de "> watermark", usa "> watermark - N min".
  -- Sem isto, edição que chega com carimbo retroativo (transação longa, relógio
  -- da fonte atrasado) cai atrás do watermark e some para sempre. Reler é barato
  -- porque a compactação absorve a repetição.
  add column watermark_lag_minutes int not null default 0;

-- Mesmo espírito do pareamento sync_mode='incremental' <-> incremental_key: a
-- 2ª chave SEM identidade é estado que só produz duplicata, e não deveria
-- existir no banco.
alter table datasets add constraint datasets_key2_needs_dedupe
  check (incremental_key_2 is null or cardinality(dedupe_keys) > 0);

-- Piso fixo e piso relativo são o mesmo campo conceitual — os dois juntos
-- seriam ambíguos na hora de montar o WHERE.
alter table datasets add constraint datasets_sync_since_exclusive
  check (sync_since is null or sync_since_days is null);

alter table datasets add constraint datasets_sync_since_days_range
  check (sync_since_days is null or sync_since_days between 1 and 3650);

-- Teto de 7 dias de folga: acima disso a reconferência deixa de ser margem de
-- segurança e vira recarga periódica disfarçada.
alter table datasets add constraint datasets_watermark_lag_range
  check (watermark_lag_minutes between 0 and 10080);
