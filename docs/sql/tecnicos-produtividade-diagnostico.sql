-- =============================================================================
-- DIAGNÓSTICO — por que a produtividade voltou com 0 linhas
--
-- NÃO salve isto como conjunto. Cole na "Consulta SQL" da tela de calculado,
-- clique em Pré-visualizar, leia, e depois volte a query de verdade.
--
-- Lê de cima para baixo e pare na PRIMEIRA linha que vier zerada: é ali que o
-- dado some. Cada etapa acrescenta exatamente uma condição à anterior, então a
-- primeira queda para zero aponta a condição culpada, sem adivinhação.
-- =============================================================================
WITH
src_assignment_incidents AS (SELECT * FROM assignment_incidents),
src_assignments          AS (SELECT * FROM assignments),
src_incident_types       AS (SELECT * FROM incident_types),
src_schedules            AS (SELECT * FROM schedules),
src_incident_status      AS (SELECT * FROM incident_status),
src_people               AS (SELECT * FROM people),
src_teams                AS (SELECT * FROM teams),
src_ppl_itens            AS (SELECT * FROM patrimony_packing_list_items),
src_ppl                  AS (SELECT * FROM patrimony_packing_lists),
src_reports              AS (SELECT * FROM reports),

-- ── 1. Os 10 conjuntos têm dado no lake? ──────────────────────────────────
-- Um único deles vazio zera tudo: as junções do meio são todas INNER.
volume AS (
    SELECT 11 AS ordem, 'conjunto: assignments'               AS medida, CAST(count(*) AS VARCHAR) AS valor FROM src_assignments
    UNION ALL SELECT 12, 'conjunto: assignment_incidents',          CAST(count(*) AS VARCHAR) FROM src_assignment_incidents
    UNION ALL SELECT 13, 'conjunto: incident_types',                CAST(count(*) AS VARCHAR) FROM src_incident_types
    UNION ALL SELECT 14, 'conjunto: incident_status',               CAST(count(*) AS VARCHAR) FROM src_incident_status
    UNION ALL SELECT 15, 'conjunto: schedules',                     CAST(count(*) AS VARCHAR) FROM src_schedules
    UNION ALL SELECT 16, 'conjunto: people',                        CAST(count(*) AS VARCHAR) FROM src_people
    UNION ALL SELECT 17, 'conjunto: teams',                         CAST(count(*) AS VARCHAR) FROM src_teams
    UNION ALL SELECT 18, 'conjunto: reports',                       CAST(count(*) AS VARCHAR) FROM src_reports
    UNION ALL SELECT 19, 'conjunto: patrimony_packing_lists',       CAST(count(*) AS VARCHAR) FROM src_ppl
    UNION ALL SELECT 20, 'conjunto: patrimony_packing_list_items',  CAST(count(*) AS VARCHAR) FROM src_ppl_itens
),

-- ── 2. O corte de data bate com o que existe? ─────────────────────────────
-- Se o conjunto foi publicado com piso ("a partir de") ou a carga ainda não
-- alcançou 2026, o filtro sozinho zera o resultado inteiro.
datas AS (
    SELECT 21 AS ordem, 'assignments.created: mais antigo'  AS medida, CAST(min(a.created) AS VARCHAR) AS valor FROM src_assignments a
    UNION ALL SELECT 22, 'assignments.created: mais recente', CAST(max(a.created) AS VARCHAR) FROM src_assignments a
    UNION ALL SELECT 23, 'assignments com created >= 2026-01-01',
                         CAST(count(*) AS VARCHAR) FROM src_assignments a WHERE a.created >= TIMESTAMP '2026-01-01'
    UNION ALL SELECT 24, 'patrimony itens com out_date > 2026-01-01',
                         CAST(count(*) AS VARCHAR) FROM src_ppl_itens i WHERE i.out_date > TIMESTAMP '2026-01-01'
    UNION ALL SELECT 25, 'reports com final_date >= 2026-01-01',
                         CAST(count(*) AS VARCHAR) FROM src_reports r WHERE r.final_date >= TIMESTAMP '2026-01-01'
),

-- ── 3. Os 12 tipos de protocolo existem com ESTES ids? ────────────────────
-- Se o conjunto incident_types usa outra codificação, o IN não casa com nada.
tipos AS (
    SELECT 31 AS ordem, 'incident_types: total' AS medida, CAST(count(*) AS VARCHAR) AS valor FROM src_incident_types
    UNION ALL SELECT 32, 'incident_types: quantos dos 12 ids existem',
        CAST(count(*) AS VARCHAR) FROM src_incident_types
        WHERE TRY_CAST(id AS BIGINT) IN (12, 1014, 1254, 1255, 1256, 1136, 249, 268, 1160, 1015, 279, 15)
    UNION ALL SELECT 33, 'incident_types: quais ids casaram',
        string_agg(CAST(TRY_CAST(id AS BIGINT) AS VARCHAR), ', ' ORDER BY TRY_CAST(id AS BIGINT)) FROM src_incident_types
        WHERE TRY_CAST(id AS BIGINT) IN (12, 1014, 1254, 1255, 1256, 1136, 249, 268, 1160, 1015, 279, 15)
    -- O título exato importa: o CASE do técnico compara com a string inteira.
    UNION ALL SELECT 34, 'incident_types: titulo do id 15 (troca de endereco)',
        string_agg(title, ' | ') FROM src_incident_types WHERE TRY_CAST(id AS BIGINT) = 15
),

-- ── 4. As junções da base sobrevivem, uma a uma? ──────────────────────────
funil AS (
    SELECT 41 AS ordem, 'A. incidentes x assignments' AS medida, CAST(count(*) AS VARCHAR) AS valor
      FROM src_assignment_incidents ai JOIN src_assignments a ON a.id = ai.assignment_id
    UNION ALL SELECT 42, 'B. A + tipo entre os 12', CAST(count(*) AS VARCHAR)
      FROM src_assignment_incidents ai
      JOIN src_assignments    a  ON a.id  = ai.assignment_id
      JOIN src_incident_types it ON it.id = ai.incident_type_id
        AND TRY_CAST(it.id AS BIGINT) IN (12, 1014, 1254, 1255, 1256, 1136, 249, 268, 1160, 1015, 279, 15)
    UNION ALL SELECT 43, 'C. B + created >= 2026-01-01 (= a base)', CAST(count(*) AS VARCHAR)
      FROM src_assignment_incidents ai
      JOIN src_assignments    a  ON a.id  = ai.assignment_id
      JOIN src_incident_types it ON it.id = ai.incident_type_id
        AND TRY_CAST(it.id AS BIGINT) IN (12, 1014, 1254, 1255, 1256, 1136, 249, 268, 1160, 1015, 279, 15)
      WHERE a.created >= TIMESTAMP '2026-01-01'
    UNION ALL SELECT 44, 'D. C + status diferente de Cancelado', CAST(count(*) AS VARCHAR)
      FROM src_assignment_incidents ai
      JOIN src_assignments    a  ON a.id  = ai.assignment_id
      JOIN src_incident_types it ON it.id = ai.incident_type_id
        AND TRY_CAST(it.id AS BIGINT) IN (12, 1014, 1254, 1255, 1256, 1136, 249, 268, 1160, 1015, 279, 15)
      LEFT JOIN src_incident_status is2 ON is2.id = ai.incident_status_id
      WHERE a.created >= TIMESTAMP '2026-01-01' AND is2.title IS DISTINCT FROM 'Cancelado'
)

SELECT medida, valor FROM (
    SELECT * FROM volume
    UNION ALL SELECT * FROM datas
    UNION ALL SELECT * FROM tipos
    UNION ALL SELECT * FROM funil
) t
ORDER BY ordem
