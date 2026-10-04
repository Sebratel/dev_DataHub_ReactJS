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
    # SNAPSHOT substitui a tabela. overwriteSchema porque a origem é um ERP:
    # coluna nova aparece sem aviso, e falhar a carga por isso seria pior.
    (df.write
       .mode("overwrite")
       .option("overwriteSchema", "true")
       .saveAsTable(tabela))

    spark.sql(f"""
      insert into {CONTROLE} values (
        '{run_id}', '{slug}', '{camada}', '{tabela}', {linhas},
        '{caminho}', timestamp'{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}'
      )
    """)
    processados.add(run_id)
    carregados += 1
    print(f"OK  {tabela}: {linhas} linha(s) de {m.get('source_parts')} parte(s) no lake.")

# COMMAND ----------

print(f"\nCarregadas: {carregados} · já processadas: {pulados} · falhas: {len(falhas)}")
for caminho, motivo in falhas:
    print(f"FALHA {os.path.basename(caminho)}: {motivo}")

# Falhar a execução quando algo não entrou: um job verde com tabela
# desatualizada é pior do que um job vermelho — ninguém vai investigar o verde.
if falhas:
    raise Exception(f"{len(falhas)} manifesto(s) não carregado(s). Veja a lista acima.")
