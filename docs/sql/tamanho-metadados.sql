-- Tamanho do banco de METADADOS do Data Hub (Postgres), para planejar a cópia
-- para o MariaDB (docs/MIGRACAO-MARIADB.md). Só leitura.
--   docker exec -i datahub-db psql -U datahub -d datahub < docs/sql/tamanho-metadados.sql
\pset footer off
select current_database() as banco, pg_size_pretty(pg_database_size(current_database())) as tamanho_total,
       (select count(*) from pg_stat_user_tables) as tabelas,
       (select count(*) from datasets) as conjuntos;

select relname as tabela, n_live_tup as linhas,
       pg_size_pretty(pg_total_relation_size(relid)) as tamanho
  from pg_stat_user_tables
 order by pg_total_relation_size(relid) desc
 limit 15;

select max(applied_at)::date as ultima_migration, count(*) as migrations from schema_migrations;
