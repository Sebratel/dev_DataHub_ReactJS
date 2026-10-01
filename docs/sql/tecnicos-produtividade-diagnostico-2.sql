-- =============================================================================
-- DIAGNÓSTICO 2 — onde a base zera (8 linhas, cabe na tela sem rolar)
--
-- O primeiro diagnóstico já provou o que NÃO é: os 10 conjuntos têm dado
-- (reports com 8,1 mi, assignments com 2,2 mi) e há `created` até hoje. Então
-- não é conjunto vazio nem janela de data.
--
-- Sobrou a junção. Estas 8 linhas separam as três causas que restam:
--   • não existe protocolo DESSES tipos  → linha 1 vem zerada;
--   • a junção ai x assignments não casa → linha 2 vem zerada (e aí a linha 7
--     explica: tipos de dado diferentes entre as duas colunas de chave);
--   • os ids dos 12 tipos são outros     → linha 3 cai e a linha 5 mostra
--     quais dos 12 realmente existem, contra a linha 8, que mostra os tipos
--     mais usados de verdade.
--
-- Não salve como conjunto: cole, pré-visualize, leia, apague.
--
-- ┌─ O QUE ISTO ACHOU, em 01/10/2026 ───────────────────────────────────────┐
-- │ Linha 7: assignments.id, ai.assignment_id, it.id e ai.incident_type_id  │
-- │ são todos DOUBLE. Logo CAST(id AS VARCHAR) = "12.0", que nunca casa com │
-- │ '12' — as linhas 1, 3, 4 e 5 vinham zeradas por isso, embora o tipo 12  │
-- │ tenha 249.107 incidentes (linha 8).                                     │
-- │ Este arquivo já foi corrigido para comparar id como NÚMERO.             │
-- └─────────────────────────────────────────────────────────────────────────┘
-- =============================================================================
WITH
src_assignment_incidents AS (SELECT * FROM assignment_incidents),
src_assignments          AS (SELECT * FROM assignments),
src_incident_types       AS (SELECT * FROM incident_types),

doze AS (SELECT unnest([12, 1014, 1254, 1255, 1256, 1136, 249, 268, 1160, 1015, 279, 15]) AS id_num)

SELECT medida, valor FROM (
    -- 1. Existe protocolo desses tipos, sem depender de junção nenhuma?
    SELECT 1 AS ordem, '1. incidentes com tipo entre os 12 (sem juncao)' AS medida,
           CAST(count(*) AS VARCHAR) AS valor
      FROM src_assignment_incidents ai
     WHERE TRY_CAST(ai.incident_type_id AS BIGINT) IN (SELECT id_num FROM doze)

    -- 2. A junção mais básica de todas.
    UNION ALL SELECT 2, '2. A: incidentes x assignments', CAST(count(*) AS VARCHAR)
      FROM src_assignment_incidents ai JOIN src_assignments a ON a.id = ai.assignment_id

    UNION ALL SELECT 3, '3. B: A + tipo entre os 12', CAST(count(*) AS VARCHAR)
      FROM src_assignment_incidents ai
      JOIN src_assignments    a  ON a.id  = ai.assignment_id
      JOIN src_incident_types it ON it.id = ai.incident_type_id
       AND TRY_CAST(it.id AS BIGINT) IN (SELECT id_num FROM doze)

    UNION ALL SELECT 4, '4. C: B + created >= 2026-01-01  (= a base)', CAST(count(*) AS VARCHAR)
      FROM src_assignment_incidents ai
      JOIN src_assignments    a  ON a.id  = ai.assignment_id
      JOIN src_incident_types it ON it.id = ai.incident_type_id
       AND TRY_CAST(it.id AS BIGINT) IN (SELECT id_num FROM doze)
     WHERE a.created >= TIMESTAMP '2026-01-01'

    -- 5. Dos 12 ids pedidos, quais existem mesmo no catálogo de tipos?
    UNION ALL SELECT 5, '5. quais dos 12 ids existem em incident_types',
           coalesce(string_agg(CAST(TRY_CAST(it.id AS BIGINT) AS VARCHAR), ', '), 'NENHUM')
      FROM src_incident_types it
     WHERE TRY_CAST(it.id AS BIGINT) IN (SELECT id_num FROM doze)

    -- 6. O CASE do técnico compara a string inteira — precisa bater letra a letra.
    UNION ALL SELECT 6, '6. titulo exato do id 15',
           coalesce(string_agg(it.title, ' | '), 'ID 15 NAO EXISTE')
      FROM src_incident_types it WHERE TRY_CAST(it.id AS BIGINT) = 15

    -- 7. Chave de texto de um lado e número do outro não casa, e não dá erro.
    UNION ALL SELECT 7, '7. tipos de dado das chaves',
           'assignments.id=' || (SELECT typeof(a.id) FROM src_assignments a LIMIT 1)
        || ' | ai.assignment_id=' || (SELECT typeof(ai.assignment_id) FROM src_assignment_incidents ai LIMIT 1)
        || ' | it.id=' || (SELECT typeof(it.id) FROM src_incident_types it LIMIT 1)
        || ' | ai.incident_type_id=' || (SELECT typeof(ai.incident_type_id) FROM src_assignment_incidents ai LIMIT 1)

    -- 8. Os tipos realmente usados. Se nenhum dos 12 aparecer aqui, a lista do
    --    relatório é de outra codificação.
    UNION ALL SELECT 8, '8. tipos mais usados em assignment_incidents',
           (SELECT string_agg(x.rotulo, ' | ') FROM (
                SELECT CAST(TRY_CAST(ai.incident_type_id AS BIGINT) AS VARCHAR) || ' (' || CAST(count(*) AS VARCHAR) || ')' AS rotulo
                  FROM src_assignment_incidents ai
                 GROUP BY ai.incident_type_id
                 ORDER BY count(*) DESC
                 LIMIT 5) x)
) t
ORDER BY ordem
