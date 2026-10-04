-- Publicação de conjuntos no Databricks (piloto Native/Matrix).
--
-- O Data Hub continua sendo o motor: extrai, trata e materializa como já faz.
-- A publicação é um PASSO A MAIS no fim — consolida as partes do lake num único
-- Parquet e envia para um volume do Unity Catalog. O Databricks nunca alcança
-- os bancos da Sebratel; a conexão é só de saída, por HTTPS.

-- Desligado por conjunto, e por padrão. Ligar é um ato deliberado: o conjunto
-- passa a sair da rede interna, e a seção 8 do spec exige conferir dado pessoal
-- (login, avaliação) antes de habilitar.
alter table datasets add column databricks_enabled boolean not null default false;

-- SNAPSHOT substitui a tabela inteira no destino; INCREMENTAL fica para depois
-- do piloto e usará dedupe_keys/incremental_key, que o catálogo já tem.
alter table datasets add column databricks_mode text not null default 'SNAPSHOT';
alter table datasets add constraint datasets_databricks_mode_check
  check (databricks_mode in ('SNAPSHOT', 'INCREMENTAL'));

-- Camada no destino, que vira pasta no volume e schema no catálogo.
--
-- Fica NULA por padrão de propósito: o hub não tem (e não precisa ter) o
-- conceito de medalhão no banco — ele tem `kind`, que já separa o que veio de
-- fonte do que foi calculado. Nulo resolve para 'bronze' quando kind='source' e
-- 'prata' quando kind='derived'. Preencher só é necessário para promover um
-- calculado a 'ouro', que é julgamento de quem modela, não do código.
alter table datasets add column databricks_layer text;
alter table datasets add constraint datasets_databricks_layer_check
  check (databricks_layer is null or databricks_layer in ('bronze', 'prata', 'ouro'));

-- Log de envios. Espelha sync_runs, mas separado: um envio pode falhar com a
-- materialização intacta (e o contrário nunca acontece). Juntar os dois numa
-- tabela só faria "falhou" significar duas coisas diferentes.
create table databricks_sync_runs (
  -- = run_id usado no nome do arquivo e no manifesto. Reenviar o mesmo run_id
  -- sobrescreve os mesmos caminhos no volume, em vez de duplicar dado.
  id uuid primary key,
  dataset_id uuid references datasets(id) on delete set null,
  -- Guardado como texto, e não só por FK: o slug é o nome da pasta no volume.
  -- Se o conjunto for excluído, o histórico precisa continuar dizendo para onde
  -- aqueles arquivos foram.
  dataset_slug text not null,
  status text not null check (status in ('SUCCESS', 'FAILED', 'SKIPPED')),
  mode text not null check (mode in ('SNAPSHOT', 'INCREMENTAL')),
  -- Quantas partes part-*.parquet entraram na consolidação. Quando este número
  -- é alto e row_count não cresce na mesma proporção, a compactação está
  -- atrasada — é o sintoma ficando visível antes de virar problema.
  source_parts int,
  -- Linhas do arquivo CONSOLIDADO enviado, não datasets.row_count: no modo
  -- incremental, antes da compactação, a mesma linha vive em várias partes e os
  -- dois números divergem de propósito.
  row_count bigint,
  file_size_bytes bigint,
  file_path text,
  attempts int not null default 0,
  -- Mensagem resumida. Nunca token, nunca stack trace (seção 8 do spec).
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- O acesso dominante é "como está o último envio deste conjunto?", na tela de
-- Conjuntos e no alerta de 2 falhas seguidas.
create index databricks_sync_runs_dataset_idx
  on databricks_sync_runs (dataset_slug, started_at desc);
