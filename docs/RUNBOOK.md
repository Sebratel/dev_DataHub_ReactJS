# Runbook operacional — Data Hub Sebratel

Guia prático para operar o hub: sincronização, incidentes de disco/sobrecarga e
os "botões" (variáveis de ambiente) de proteção. Para a arquitetura, ver o
código; aqui é o **o que fazer quando**.

> Convenções: comandos de **host** rodam no servidor (SSH/Portainer console).
> Comandos de **container** usam `docker exec`. Ajuste nomes se a stack mudar.

---

## 1. Como a sincronização funciona (resumo)

- Fonte (Postgres/MySQL/MariaDB) → lê em **lotes** → grava **Parquet** no lake.
- **Uma sincronização por vez** no hub inteiro (fila sequencial em memória).
- **Modos**: `snapshot` (recarrega tudo), `incremental` (só o que mudou, por
  watermark/keyset) e `live` (não vai pro lake).
- **Cadência por conjunto**: `daily` (janela `ETL_HOUR`), `hourly`, `manual`.
- Tudo isso é configurado por admin na tela do conjunto → "Sincronização com o lake".

**Regra de ouro:** tabela grande = **incremental**, nunca snapshot. Snapshot com
`OFFSET` numa tabela grande/ativa relê linhas, não converge e pode encher o disco.

---

## 2. Primeira carga de uma tabela GRANDE (checklist)

Ex.: tabela de milhões de linhas com colunas `id` e `modified`.

1. **Garanta o disjuntor** na stack: `SYNC_MAX_ROWS` = ~1,5× o tamanho real
   (ex.: `20000000`). Aborta automaticamente uma carga em fuga.
2. Na tela do conjunto → **Sincronização com o lake**:
   - **Modo**: `Incremental (só novidades, por watermark)`.
   - **Chave incremental**: `modified` (pega inserts **e** updates) ou `id` (só
     cresce, sem updates). Precisa ter índice na fonte para ser rápido.
   - **Publicar a partir de** (cutoff): ex.: `2026-01-01` → a 1ª carga já começa
     desse ponto, cortando o volume na origem.
   - **Cadência**: `Manual` (por enquanto).
   - **Salvar configuração**.
3. **Sincronizar agora**, fora do horário de pico. Acompanhe "Linhas novas" subir
   ao vivo. Se precisar, o botão **Parar** aborta com segurança.
4. Terminou → mude a **Cadência para `Diária`**. As próximas rodadas só puxam o
   delta (rápido).
5. Se a tabela tem **UPDATEs**, crie um derivado "estado atual" para deduplicar:
   ```sql
   select * exclude (rn) from (
     select *, row_number() over (partition by id order by modified desc) as rn
     from NOME_DA_BASE
   ) where rn = 1
   ```

---

## 3. Parar uma sincronização

- **Parar a que está rodando**: botão **Parar** no painel (cancelamento
  cooperativo — para no próximo lote, descarta o temporário, mantém os dados
  antigos). Se a tela não abrir, reiniciar o container também aborta com segurança.
- **Parar as automáticas**: mude a **Cadência para `Manual`**.
- Registro órfão `running` após um restart (cosmético):
  ```bash
  docker exec -i datahub-db psql -U datahub -d datahub -c \
    "update sync_runs set status='error', error='abortado por restart', finished_at=now() where status='running';"
  ```

---

## 4. Disco cheio — diagnóstico e limpeza

### Diagnóstico (read-only)
```bash
df -h /
docker system df -v
# Lake e staging (o staging é o suspeito nº1 numa carga que morreu)
docker exec datahub-api sh -c "du -sh /app/data/lake /app/data/lake/.staging 2>/dev/null; du -sh /app/data/lake/*/* 2>/dev/null | sort -h | tail -20"
# Maiores volumes do host
sudo du -h --max-depth=1 /var/lib/docker/volumes 2>/dev/null | sort -h | tail -20
```

### Limpeza SEGURA
```bash
# Staging órfão (JSONL de carga morta). Confirme 0 syncs rodando antes:
docker exec -i datahub-db psql -U datahub -d datahub -c "select count(*) from sync_runs where status='running';"
docker exec datahub-api sh -c "rm -f /app/data/lake/.staging/*.jsonl"
# Logs de container + lixo do Docker
sudo truncate -s 0 /var/lib/docker/containers/*/*-json.log
docker system prune -f
```
> A partir da versão atual, a API **limpa o staging órfão sozinha no boot** — um
> restart já resolve o caso do JSONL gigante.

### Com CUIDADO
- **Parquet inflado** de um dataset (resquício de snapshot duplicado): zere só a
  pasta dele (`rm -f /app/data/lake/*/SLUG/*.parquet`) e recarregue via incremental.
- **Elasticsearch** (volume `elk_*`): consumidor grande e **separado** do hub.
  Trate com política de retenção (ILM), não apague às cegas.

---

## 5. Sobrecarga — proteções e ajustes

Camadas que protegem o servidor (defesa em profundidade):

| Risco | Proteção | Knob |
|-------|----------|------|
| Ingestão pesar na fonte | lotes + pausa + fila sequencial | `SYNC_BATCH_SIZE`, `SYNC_BATCH_PAUSE_MS` |
| Carga em fuga | disjuntor (aborta) | `SYNC_MAX_ROWS` |
| Consulta lenta pendurar a fonte | timeout no servidor de origem | `SOURCE_STATEMENT_TIMEOUT_MS` |
| Consulta pesada no hub | memória/threads/timeout do motor | `DUCK_MEMORY_LIMIT`, `DUCK_THREADS`, `DUCK_QUERY_TIMEOUT_MS` |
| Pico de consultas simultâneas | limitador de concorrência (fila) | `DUCK_MAX_CONCURRENCY` |
| Disco por log de container | rotação de log (compose) | `max-size`/`max-file` |
| Disco por staging órfão | limpeza no boot | — (automático) |

Para deixar a ingestão mais gentil: lote menor + pausa maior (ex.:
`SYNC_BATCH_SIZE=20000`, `SYNC_BATCH_PAUSE_MS=1500`).

---

## 6. Variáveis de ambiente (knobs) e defaults

| Variável | Default | Para quê |
|----------|---------|----------|
| `ETL_HOUR` | `3` | Hora da janela de sync diário |
| `SYNC_BATCH_SIZE` | `50000` | Linhas por lote na ingestão |
| `SYNC_BATCH_PAUSE_MS` | `500` | Pausa entre lotes |
| `SYNC_MAX_ROWS` | `0` (off) | Disjuntor anti-fuga (recomenda-se definir) |
| `SYNC_STAGING_DIR` | `<lake>/.staging` | Onde fica o JSONL temporário |
| `SOURCE_STATEMENT_TIMEOUT_MS` | `120000` | Teto de consulta nas fontes (PG e MySQL) |
| `DUCK_MEMORY_LIMIT` | `2GB` | Memória do motor de consulta |
| `DUCK_THREADS` | `4` | Threads do motor |
| `DUCK_QUERY_TIMEOUT_MS` | `30000` | Timeout de consulta interativa |
| `DUCK_MAX_CONCURRENCY` | `6` | Máx. de consultas simultâneas |
| `EMBEDDINGS_ENABLED` | `true` | Liga a busca semântica (RAG) |
| `EMBEDDINGS_CACHE_DIR` | `/app/.models` | Cache do modelo de embeddings |

---

## 7. Busca semântica (RAG) — operação

- Modelo local (`multilingual-e5-small`) roda dentro da API; **sem chave/custo**.
- No 1º boot baixa ~120MB (precisa de saída para a internet) e cacheia no volume
  `datahub-models`. Se falhar, degrada para **busca textual** — o chat não quebra.
- Ver o que está indexado:
  ```bash
  docker exec -i datahub-db psql -U datahub -d datahub -c \
    "select slug, name, vector_dims(embedding) as dims, embedded_at from datasets order by embedded_at nulls first;"
  ```
- Reindexar tudo (admin): `POST /api/v1/datasets/reindex-embeddings`. Também roda
  no boot, no tick do scheduler e ao publicar/editar um conjunto.

---

## 8. Recuperação rápida (ordem sugerida num incidente)

1. `df -h /` — o disco está cheio?
2. Achou staging gigante? Confirme 0 syncs rodando → apague o `.jsonl` → reinicie.
3. Deploy falhando (container unhealthy)? Veja `docker logs datahub-api` — a API
   sobe em modo degradado se o banco estiver fora; embeddings nunca derrubam o boot.
4. Tabela pesando na fonte? Cadência → `Manual` e reconfigure para incremental.
5. Depois de estabilizar, defina `SYNC_MAX_ROWS` e revise `DUCK_MAX_CONCURRENCY`.
