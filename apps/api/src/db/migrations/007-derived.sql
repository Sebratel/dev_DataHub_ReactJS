-- Conjuntos DERIVADOS (Sprint 7): SQL (DuckDB) sobre conjuntos já ingeridos
-- no lake, materializado como Parquet novo — joins e tratamentos SEM tocar
-- nas fontes de produção. Para derivados, connection_id/schema/object recebem
-- os placeholders 'lake'/'derived'/<slug> (mantêm as uniques do catálogo).
alter table datasets add column kind text not null default 'source';
alter table datasets add constraint datasets_kind_check check (kind in ('source', 'derived'));
alter table datasets add column transform_sql text;
