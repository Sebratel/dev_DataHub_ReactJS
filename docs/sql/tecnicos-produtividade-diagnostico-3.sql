-- =============================================================================
-- DIAGNÓSTICO 3 — por que "como auxiliar" deu 0 para os 96 técnicos
--
-- O auxiliar sai do CTE `auxiliar`, que procura a tarefa RAUX filha e lê o
-- protocolo de dentro das TAGS do relatório. Quatro condições precisam valer
-- ao mesmo tempo, e qualquer uma sozinha zera a coluna inteira sem erro:
--
--   1. existir tarefa com assignment_type = 'RAUX' (escrito assim);
--   2. ela ter corresponding_parent_id preenchido;
--   3. ela ter linha própria em assignment_incidents — essa junção é INNER e
--      não é usada em lugar nenhum do SELECT, só filtra;
--   4. as tags do relatório conterem o número do protocolo.
--
-- As linhas abaixo testam uma condição por vez, na ordem. Pare na primeira
-- zerada. A linha 9 mostra tags de verdade — se elas não tiverem número de
-- protocolo, nenhuma mudança no SQL resolve, é outro caminho de dado.
--
-- Não salve como conjunto: cole, pré-visualize, leia, apague.
-- =============================================================================
WITH
src_assignments          AS (SELECT * FROM assignments),
src_assignment_incidents AS (SELECT * FROM assignment_incidents),
src_reports              AS (SELECT * FROM reports),

raux AS (
    SELECT * FROM src_assignments a
     WHERE a.assignment_type = 'RAUX'
       AND a.corresponding_parent_id IS NOT NULL
       AND a.final_date >= TIMESTAMP '2026-01-01'
)

SELECT medida, valor FROM (
    -- 1. O valor 'RAUX' existe mesmo, escrito assim?
    SELECT 1 AS ordem, '1. tipos de tarefa mais comuns' AS medida,
        (SELECT string_agg(x.r, ' | ') FROM (
            SELECT coalesce(a.assignment_type, '(nulo)') || ' (' || CAST(count(*) AS VARCHAR) || ')' AS r
              FROM src_assignments a GROUP BY a.assignment_type
             ORDER BY count(*) DESC LIMIT 6) x) AS valor

    UNION ALL SELECT 2, '2. tarefas com assignment_type = RAUX', CAST(count(*) AS VARCHAR)
      FROM src_assignments a WHERE a.assignment_type = 'RAUX'

    UNION ALL SELECT 3, '3. + com corresponding_parent_id preenchido', CAST(count(*) AS VARCHAR)
      FROM src_assignments a
     WHERE a.assignment_type = 'RAUX' AND a.corresponding_parent_id IS NOT NULL

    UNION ALL SELECT 4, '4. + com final_date >= 2026-01-01  (= o CTE raux)', CAST(count(*) AS VARCHAR)
      FROM raux

    -- 5. O relatorio da tarefa auxiliar existe?
    UNION ALL SELECT 5, '5. + com relatorio (reports)', CAST(count(*) AS VARCHAR)
      FROM raux a JOIN src_reports r ON r.assignment_id = a.id

    -- 6. A junção INNER que ninguém usa, e que pode estar matando tudo.
    UNION ALL SELECT 6, '6. + com linha em assignment_incidents (o JOIN mudo)', CAST(count(*) AS VARCHAR)
      FROM raux a
      JOIN src_reports              r  ON r.assignment_id  = a.id
      JOIN src_assignment_incidents ai ON ai.assignment_id = a.id

    -- 7. As tags têm dígito? Sem dígito não há chave.
    UNION ALL SELECT 7, '7. + com tags contendo algum digito', CAST(count(*) AS VARCHAR)
      FROM raux a
      JOIN src_reports              r  ON r.assignment_id  = a.id
      JOIN src_assignment_incidents ai ON ai.assignment_id = a.id
     WHERE NULLIF(regexp_replace(coalesce(CAST(r.tags AS VARCHAR), ''), '[^0-9]', '', 'g'), '') IS NOT NULL

    -- 8. E essa chave encontra algum protocolo de verdade?
    UNION ALL SELECT 8, '8. + cuja chave casa com um protocolo existente', CAST(count(*) AS VARCHAR)
      FROM raux a
      JOIN src_reports              r  ON r.assignment_id  = a.id
      JOIN src_assignment_incidents ai ON ai.assignment_id = a.id
      JOIN src_assignment_incidents alvo
        ON coalesce(TRY_CAST(alvo.protocol AS BIGINT),
                    TRY_CAST(NULLIF(regexp_replace(CAST(alvo.protocol AS VARCHAR), '[^0-9]', '', 'g'), '') AS BIGINT))
         = coalesce(TRY_CAST(r.tags AS BIGINT),
                    TRY_CAST(NULLIF(regexp_replace(CAST(r.tags AS VARCHAR), '[^0-9]', '', 'g'), '') AS BIGINT))

    -- 9. Como as tags são DE VERDADE. Se não houver protocolo aí dentro,
    --    nenhuma mudança neste SQL resolve.
    UNION ALL SELECT 9, '9. amostra de tags de relatorio de RAUX',
        (SELECT string_agg(x.t, '  //  ') FROM (
            SELECT CAST(r.tags AS VARCHAR) AS t
              FROM raux a JOIN src_reports r ON r.assignment_id = a.id
             WHERE r.tags IS NOT NULL LIMIT 5) x)

    UNION ALL SELECT 10, '10. tipo de dado de reports.tags',
        (SELECT typeof(r.tags) FROM src_reports r LIMIT 1)
) t
ORDER BY ordem
