# Databricks notebook source
# MAGIC %md
# MAGIC # Limpeza do volume de chegada
# MAGIC
# MAGIC O Data Hub envia 13 vezes por dia, por conjunto. Os arquivos são
# MAGIC **descartáveis**: existem só para a viagem até a tabela Delta, que é
# MAGIC quem guarda o dado. Sem limpeza, o volume cresce para sempre.
# MAGIC
# MAGIC Apaga o que tem mais de `RETENCAO_DIAS` (7 por padrão). A margem é
# MAGIC generosa de propósito — o envio é de hora em hora, então nada com uma
# MAGIC semana de idade ainda está esperando carga. Se o job de carga estiver
# MAGIC parado há mais de 7 dias, o problema é o job parado, não o disco.
# MAGIC
# MAGIC Roda uma vez por dia. Só apaga `.parquet` e `.manifest.json` **dentro do
# MAGIC volume de chegada** — inclusive em `_dev`, que também acumula lixo.

# COMMAND ----------

import os
import time
from datetime import datetime, timezone

dbutils.widgets.text("retencao_dias", "7")
RETENCAO_DIAS = int(dbutils.widgets.get("retencao_dias"))

CATALOG = "piloto_mariadb"
VOLUME = f"/Volumes/{CATALOG}/landing/arquivos"
EXTENSOES = (".parquet", ".manifest.json")
corte = time.time() - RETENCAO_DIAS * 86400

print(f"Volume: {VOLUME}")
print(f"Apagando anteriores a {datetime.fromtimestamp(corte, timezone.utc):%Y-%m-%d %H:%M} UTC "
      f"({RETENCAO_DIAS} dias)\n")

# COMMAND ----------

apagados, bytes_liberados, erros = 0, 0, []

for raiz, _dirs, arquivos in os.walk(VOLUME):
    for nome in arquivos:
        if not nome.endswith(EXTENSOES):
            continue
        caminho = os.path.join(raiz, nome)
        # Trava de segurança: nunca sair do volume de chegada. Um os.walk que
        # seguisse link para fora apagaria o que não é nosso.
        if not os.path.abspath(caminho).startswith(VOLUME):
            continue
        try:
            st = os.stat(caminho)
            if st.st_mtime >= corte:
                continue
            os.remove(caminho)
            apagados += 1
            bytes_liberados += st.st_size
        except Exception as e:
            erros.append((caminho, str(e)))

# COMMAND ----------

# Pastas dt=... vazias depois da limpeza só poluem a navegação.
vazias = 0
for raiz, dirs, arquivos in os.walk(VOLUME, topdown=False):
    if raiz == VOLUME:
        continue
    try:
        if not os.listdir(raiz):
            os.rmdir(raiz)
            vazias += 1
    except Exception:
        pass  # pasta em uso ou recriada no meio: não é problema

print(f"Apagados: {apagados} arquivo(s), {bytes_liberados / 1024 / 1024:.1f} MB")
print(f"Pastas vazias removidas: {vazias}")
for caminho, motivo in erros:
    print(f"FALHA {caminho}: {motivo}")

# Limpeza que falha não pode passar por limpeza que funcionou: o disco encheria
# em silêncio até alguém descobrir pelo alerta de espaço.
if erros:
    raise Exception(f"{len(erros)} arquivo(s) não puderam ser apagados.")
