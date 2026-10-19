# Databricks notebook source
# MAGIC %md
# MAGIC # Carga: volume de chegada → tabelas Delta
# MAGIC
# MAGIC O Data Hub envia, para cada conjunto habilitado, um Parquet consolidado e
# MAGIC um `manifest.json`. **O manifesto é enviado por último, e é ele que
# MAGIC autoriza a carga** — enquanto não chega, o Parquet ali é um envio pela
# MAGIC metade e deve ser ignorado.
# MAGIC
# MAGIC Este notebook é disparado pela chegada de arquivo no volume. Ele:
# MAGIC
# MAGIC 1. procura manifestos ainda não processados (controle por `run_id`);
# MAGIC 2. **ignora** qualquer caminho com pasta começando por `_` (é onde o
# MAGIC    desenvolvimento testa — teste de dev nunca pode virar tabela);
# MAGIC 3. confere `sha256` e `row_count` antes de carregar — um arquivo
# MAGIC    truncado no meio do caminho não entra em tabela nenhuma;
# MAGIC 4. carrega em `piloto_mariadb.{camada}.{slug}`, substituindo a tabela
# MAGIC    (modo `SNAPSHOT`).
# MAGIC
# MAGIC Reprocessar é seguro: o `run_id` já carregado é pulado, e `SNAPSHOT`
# MAGIC substitui em vez de acumular.

# COMMAND ----------

import hashlib
import json
import os
from datetime import datetime, timezone

CATALOG = "piloto_mariadb"
VOLUME = f"/Volumes/{CATALOG}/landing/arquivos"
CONTROLE = f"{CATALOG}.landing.cargas_processadas"
CAMADAS = {"bronze", "prata", "ouro"}

# COMMAND ----------

# Controle de idempotência. Sem ela, o gatilho de chegada de arquivo
# reprocessaria todo manifesto do volume a cada disparo — e o custo disso
# cresce com o histórico, não com o que chegou.
spark.sql(f"""
  create table if not exists {CONTROLE} (
    run_id string not null,
    dataset_slug string,
    layer string,
    table_name string,
    row_count bigint,
    manifest_path string,
    loaded_at timestamp
  )
""")

# Colunas que chegaram com o modo incremental. Em tabela já existente, o
# `create table if not exists` acima não as acrescenta — daí o alter.
#
# `row_count` passou a ser ambíguo: em SNAPSHOT é o tamanho da tabela, em
# INCREMENTAL é o tamanho do DELTA. Sem `table_rows`, qualquer conferência que
# compare o registro com a contagem real acusaria divergência em todo envio
# incremental — um alarme falso diário, que ensina a ignorar o alarme.
for coluna, tipo in (("mode", "string"), ("table_rows", "bigint")):
    try:
        spark.sql(f"alter table {CONTROLE} add column {coluna} {tipo}")
    except Exception:
        pass  # já existe

processados = {r.run_id for r in spark.table(CONTROLE).select("run_id").collect()}
print(f"{len(processados)} carga(s) já processada(s).")

# COMMAND ----------

def oculto(caminho: str) -> bool:
    """Pasta começando por '_' é área de teste: nunca vira tabela."""
    relativo = caminho[len(VOLUME):].lstrip("/")
    return any(p.startswith("_") for p in relativo.split("/")[:-1])


def manifestos():
    for raiz, _dirs, arquivos in os.walk(VOLUME):
        for nome in arquivos:
            if not nome.endswith(".manifest.json"):
                continue
            caminho = os.path.join(raiz, nome)
            if oculto(caminho):
                continue
            yield caminho


def sha256(caminho: str) -> str:
    h = hashlib.sha256()
    with open(caminho, "rb") as f:
        for bloco in iter(lambda: f.read(1024 * 1024), b""):
            h.update(bloco)
    return h.hexdigest()

# COMMAND ----------

carregados, pulados, falhas = 0, 0, []

for caminho in sorted(manifestos()):
    try:
        with open(caminho, "r", encoding="utf-8") as f:
            m = json.load(f)
    except Exception as e:
        falhas.append((caminho, f"manifesto ilegível: {e}"))
        continue

    run_id = m.get("run_id")
    if not run_id or run_id in processados:
        pulados += 1
        continue

    slug = m.get("dataset_slug", "")
    camada = m.get("layer", "")
    if camada not in CAMADAS or not slug:
        falhas.append((caminho, f"camada/slug inválidos: {camada}/{slug}"))
        continue

    # Hífen não é identificador válido em nome de tabela.
    tabela = f"{CATALOG}.{camada}.{slug.replace('-', '_')}"
    arquivos = m.get("files", [])
    if not arquivos:
        falhas.append((caminho, "manifesto sem arquivos"))
        continue

    # Conferência ANTES de carregar: o manifesto diz o que deveria ter chegado,
    # e é aqui que um envio truncado ou um arquivo trocado é pego. Carregar
    # primeiro e conferir depois deixaria a tabela errada no meio-tempo.
    problema = None
    for a in arquivos:
        p = a["path"]
        if not os.path.exists(p):
            problema = f"arquivo ausente: {p}"
            break
        tamanho = os.path.getsize(p)
        if tamanho != a.get("size_bytes"):
            problema = f"tamanho diverge em {os.path.basename(p)}: {tamanho} ≠ {a.get('size_bytes')}"
            break
        if sha256(p) != a.get("sha256"):
            problema = f"sha256 diverge em {os.path.basename(p)}"
            break
    if problema:
        falhas.append((caminho, problema))
        continue

    df = spark.read.parquet(*[a["path"] for a in arquivos])
    linhas = df.count()
    if linhas != m.get("row_count"):
        falhas.append((caminho, f"row_count diverge: {linhas} ≠ {m.get('row_count')}"))
        continue

    spark.sql(f"create schema if not exists {CATALOG}.{camada}")

    modo = m.get("mode", "SNAPSHOT")
    merge_keys = m.get("merge_keys") or []
    existe = spark.catalog.tableExists(tabela)

    if modo == "INCREMENTAL" and merge_keys and existe:
        # O arquivo traz só as linhas que mudaram desde o último envio, então
        # substituir a tabela apagaria todo o histórico que não veio junto.
        # MERGE atualiza quem já existe e insere quem é novo.
        #
        # O que o MERGE NÃO faz: apagar da tabela a linha que sumiu na origem.
        # Em SNAPSHOT isso acontece de graça (a tabela é substituída); aqui,
        # não. Uma exclusão na origem só desaparece daqui na próxima vez que o
        # conjunto for enviado inteiro — tipicamente depois de uma compactação
        # do lake, que já força envio completo.
        df.createOrReplaceTempView("delta_recebido")
        on = " and ".join(f"t.`{k}` = s.`{k}`" for k in merge_keys)
        spark.sql(f"""
          merge into {tabela} t
          using delta_recebido s on {on}
          when matched then update set *
          when not matched then insert *
        """)
        print(f"OK  {tabela}: merge de {linhas} linha(s) por {', '.join(merge_keys)}.")
        spark.catalog.dropTempView("delta_recebido")
    else:
        # SNAPSHOT substitui a tabela. overwriteSchema porque a origem é um
        # ERP: coluna nova aparece sem aviso, e falhar a carga por isso seria
        # pior. Também é o caminho do PRIMEIRO envio de um conjunto
        # incremental, quando ainda não há tabela para casar.
        (df.write
           .mode("overwrite")
           .option("overwriteSchema", "true")
           .saveAsTable(tabela))
        if modo == "INCREMENTAL" and not existe:
            print(f"    {tabela}: incremental sem tabela ainda — primeiro envio entra inteiro.")

    # Colunas nomeadas: `values` posicional quebraria em silêncio no dia em
    # que outra coluna entrasse no meio.
    total_tabela = spark.table(tabela).count()
    spark.sql(f"""
      insert into {CONTROLE}
        (run_id, dataset_slug, layer, table_name, row_count, manifest_path,
         loaded_at, mode, table_rows)
      values (
        '{run_id}', '{slug}', '{camada}', '{tabela}', {linhas},
        '{caminho}', timestamp'{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}',
        '{modo}', {total_tabela}
      )
    """)
    processados.add(run_id)
    carregados += 1
    if modo != "INCREMENTAL" or not merge_keys or not existe:
        print(f"OK  {tabela}: {linhas} linha(s) de {m.get('source_parts')} parte(s) no lake.")

# COMMAND ----------

print(f"\nCarregadas: {carregados} · já processadas: {pulados} · falhas: {len(falhas)}")
for caminho, motivo in falhas:
    print(f"FALHA {os.path.basename(caminho)}: {motivo}")

# Falhar a execução quando algo não entrou: um job verde com tabela
# desatualizada é pior do que um job vermelho — ninguém vai investigar o verde.
if falhas:
    raise Exception(f"{len(falhas)} manifesto(s) não carregado(s). Veja a lista acima.")
