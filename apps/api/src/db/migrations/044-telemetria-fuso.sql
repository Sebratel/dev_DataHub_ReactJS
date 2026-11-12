-- No Postgres não muda nada: api_call_metrics.created_at já é timestamptz.
-- A migration existe nas duas pastas porque toda migration nova precisa de par
-- (ver migrations-mariadb/044-telemetria-fuso.sql, que é onde a mudança acontece).
select 1;
