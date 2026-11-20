# Runbook operacional — Data Hub Sebratel

Guia prático para operar o hub: sincronização, incidentes de disco/sobrecarga e
os "botões" (variáveis de ambiente) de proteção. Para a arquitetura, ver o
código; aqui é o **o que fazer quando**.

> Para **decidir e validar** a regra de atualização de cada conjunto (qual
> chave, identidade da linha, cadência), o guia é
> [TREINAMENTO-ATUALIZACAO-FONTES](./TREINAMENTO-ATUALIZACAO-FONTES.md).

> Convenções: comandos de **host** rodam no servidor (SSH/Portainer console).
> Comandos de **container** usam `docker exec`. Ajuste nomes se a stack mudar.

---

## 1. Como a sincronização funciona (resumo)

- Fonte (Postgres/MySQL/MariaDB) → lê em **lotes** → grava um **staging
  comprimido** (`.jsonl.gz`) → converte para **Parquet** no lake. O staging vive
  do começo ao fim da carga e é ele, não o Parquet, que faz o disco subir
  durante uma sincronização longa.
- **Uso de disco**: a tela *Padronizar atualização* mostra no topo o percentual
  do volume, quanto o lake ocupa e os maiores conjuntos. Acima de
  `SYNC_DISK_WARN_PERCENT` (85 por padrão) o card fica em alerta e diz se há
  carga na fila — porque com fila o pico ainda vai subir.
- **Uma sincronização por vez** no hub inteiro (fila sequencial em memória).
- **Modos**: `snapshot` (recarrega tudo), `incremental` (só o que mudou, por
  watermark/keyset) e `live` (não vai pro lake).
- **Incremental usa DUAS chaves** (criação e edição), uma passada keyset para
  cada, e uma **identidade da linha** que faz a versão nova substituir a antiga
  em vez de conviver com ela. Sem identidade, o incremental só acrescenta.
- **Cadência por conjunto**: `daily` (janela `ETL_HOUR`), `hourly`, `manual`,
  `schedule` (segue um agendamento: janela + dias + intervalo em minutos) e
  `cascade` (só calculados — recalcula quando a origem atualiza).
- A **compactação** (reescrever o conjunto para colapsar duplicatas) é
  condicional: só roda quando há identidade repetida ou quando os arquivos
  passam de `SYNC_COMPACT_MAX_PARTS`. O histórico mostra `dispensada` ou o
  tempo gasto.
- Configurado na tela do conjunto → "Sincronização com o lake", ou em lote em
  **Administração › Padronizar atualização**. Mexer na regra de um conjunto de
  FONTE exige **admin master**; calculados seguem com admin/editor.

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
| `DATABRICKS_SYNC_ENABLED` | `false` | Freio geral da publicação no Databricks |
| `DATABRICKS_VOLUME_PATH` | `/Volumes/piloto_mariadb/landing/arquivos` | Destino; em dev use `.../_dev` |
| `DATABRICKS_UPLOAD_MAX_RETRIES` | `5` | Retentativas em 429/5xx/rede |
| `DATABRICKS_SOURCE_TZ` | `America/Sao_Paulo` | Fuso que o lake gravou (vira UTC no envio) |
| `RECONCILE_HOUR` | `6` | Hora da escolha diária da conciliação fonte × lake |
| `DQ_SMALL_MAX_ROWS` | `100000` | Até aqui o conjunto é "pequeno" (D-QLD-3) |
| `DQ_LARGE_MIN_ROWS` | `2000000` | A partir daqui é "grande" |
| `DQ_LARGE_WINDOW_DAYS` | `60` | Quantos dias o conjunto grande confere |

> Variável nova **tem** que entrar no bloco `environment` do `docker-compose.yml`:
> o que não estiver listado lá não chega ao contêiner, por mais preenchido que
> apareça no Portainer. `npm run env:smoke --workspace apps/api` confere isso.

---

## 7. Publicação no Databricks — operação

O Data Hub **envia**; o Databricks nunca alcança os bancos da Sebratel. Depois de
cada materialização, o conjunto habilitado é consolidado num único Parquet e
enviado ao volume, com um manifesto por último — é o manifesto que autoriza o
job de carga a ler.

- **Ligar um conjunto:** tela do conjunto → *Publicação no Databricks*. Só o
  **admin master** liga, porque aqui o dado sai da rede interna.
- **Testar sem virar tabela:** aponte `DATABRICKS_VOLUME_PATH` para
  `.../arquivos/_dev`. O job de carga ignora pastas que começam com `_`.
- **Por que um envio não saiu:** a tela mostra o último status e o erro. `401`,
  `403` e `404` **não** são repetidos (credencial, permissão ou volume errado —
  nada disso melhora sozinho); rede, `429` e `5xx` repetem com backoff.
- **Duas falhas seguidas** no mesmo conjunto imprimem `[databricks][ALERTA]` no
  log do contêiner e mandam um alerta para o chat; o envio que volta a
  funcionar depois disso também avisa. Envio pulado ("nada mudou") não conta.
- **O envio nunca atrasa a sincronização:** ele roda solto, depois do `sync_runs`
  já estar fechado. Databricks fora do ar não segura a fila.
- Histórico no banco:
  ```bash
  docker exec -i datahub-db psql -U datahub -d datahub -c \
    "select dataset_slug, status, row_count, source_parts, attempts, error_message, started_at
       from databricks_sync_runs order by started_at desc limit 20;"
  ```

**Fuso:** o lake guarda hora local de São Paulo sem fuso; o envio converte para
UTC explicitamente. Se um horário aparecer 3 h deslocado no Databricks, o
suspeito é `DATABRICKS_SOURCE_TZ`, não o Spark.

### Montar (ou remontar) o lado do Databricks

Vale para workspace novo, troca de nuvem ou religar depois de uma pausa. Tudo
pela API — nenhum passo exige compute, o que importa quando a conta está sem
crédito e nenhum warehouse sobe.

```bash
cd apps/api
# 1. catálogo piloto_mariadb, schemas landing/bronze/prata/ouro e o volume
npm run databricks:setup-catalog
# 2. permissão mínima do service principal (só escrever no volume)
npm run databricks:grants -- <applicationId>
# 3. notebooks + os dois jobs (carga por chegada de arquivo, limpeza diária)
npm run databricks:setup-job
# 4. prova de ponta a ponta: envia um conjunto pequeno e testa os limites
npm run databricks:check
```

Os três primeiros são idempotentes: rodar de novo não duplica nada.

**Pausar sem desmontar:** `npm run databricks:setup-job -- --pause` desliga os
dois jobs; `--resume` religa. Job pausado não roda e não custa, e a
configuração fica de pé.

### Acompanhar o piloto

```bash
npm run databricks:status --workspace apps/api
```

Responde a pergunta do critério de aceite — "os envios estão chegando e o
`row_count` bate?" — em três partes: contagem gravada contra `count(*)` de
agora; **manifesto no volume sem carga correspondente**; e como os dois jobs
terminaram nas últimas execuções.

A segunda parte é a que importa mais, porque é a falha silenciosa do desenho:
o envio dá sucesso, o arquivo está lá, e a tabela não existe — foi o que
aconteceria com o destino apontando para `/_dev`. Nada reclama sozinho.

Ele acorda o SQL Warehouse, então custa alguns centavos. É para acompanhamento
pontual, não para laço de monitoramento.

**Ao conferir o service principal no console, olhe o Client ID, nunca o nome.**
A tela "Add identity" transforma o UUID colado em NOME e gera um Client ID
novo — é fácil acabar com dois service principals, o secret num e a permissão
no outro.

**Trocar de nuvem (AWS ↔ GCP) não mexe no código.** O Data Hub empurra
arquivos e não sabe onde o destino está: mudam `DATABRICKS_HOST` e as
credenciais, e o `DATABRICKS_VOLUME_PATH` continua igual se os nomes de
catálogo e volume forem mantidos. O provisionamento é a sequência acima.

---

## 8. Busca semântica (RAG) — operação

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
- **Prazo das conversas (D-MON-4, R6):** a conversa com a IA é apagada 30 dias
  depois da última mensagem, na rotina de hora em hora. Antes de apagar, ela é
  somada em `ai_usage_daily` (dia × pessoa: conversas, perguntas, respostas,
  consultas e consultas com erro). Apagar pela tela também soma. Nada do
  conteúdo fica.

---

## 9. Qualidade dos dados — conciliação fonte × lake e alertas

Decisão D-QLD-3 do comitê (R4, 30/10/2026). Tela: **Operar › Qualidade dos dados**.

- **Todo dia, a partir de `RECONCILE_HOUR`**, o sistema escolhe um conjunto
  pequeno, um médio e um grande — os oficiais primeiro, depois quem está há mais
  tempo sem conferência — e confere com a fonte. "Conciliar agora" faz o mesmo
  para um conjunto só (admin).
- **A conferência carrega antes de comparar**, dentro da mesma fila das cargas:
  a fonte nunca recebe duas consultas ao mesmo tempo, e o lake comparado é o
  recém-atualizado. Conjunto `manual` e conjunto pausado ficam fora da rotina.
- **O que é comparado:** contagem e soma da identidade numérica (soma de
  controle). Com chave de data, **por dia**, até o watermark menos a folga; o
  grande só nos últimos `DQ_LARGE_WINDOW_DAYS` dias. Snapshot e chave numérica
  comparam o total. Linhas com a chave de carga vazia na fonte (nunca entram no
  lake, QLD-07) contam como divergência.
- **Ficam fora:** calculados, modo ao vivo e fontes que não são Postgres/MySQL
  (a tela mostra o motivo de cada um).
- **Onde os alertas aparecem:** em **Operar › Saúde da plataforma** (histórico
  com "marcar como visto"), no **sino do cabeçalho** (só admin) e, desde a R6
  (D-MON-3), no **Google Chat**. O webhook `{"text": …}` só o master cadastra,
  no cartão de alertas; sem ele, o alerta fica só no sistema ("sem canal").
  O mesmo assunto não se repete no chat em 12 h, e cada alerta sai na troca
  de estado (passou a falhar / voltou):
  - divergência, conciliação não concluída e "voltou a bater";
  - verificação contínua falhando e carga pausada;
  - envio ao Databricks com 2 falhas seguidas;
  - endpoint da verificação de saúde com 2 falhas seguidas (≈ 10 min na
    cadência padrão de 5 min);
  - disco do lake acima de `SYNC_DISK_WARN_PERCENT` (conferido a cada 15 min);
  - fonte fora do ar (conexão recusada, host fora, banco reiniciando): um
    aviso por FONTE, "fora do ar" e "de volta".
- **Pausa por falhas seguidas:** 3 falhas seguidas pausam o conjunto, e só uma
  ação manual (Sincronizar agora) retoma. **Fonte inalcançável não conta**
  (incidente de 17/11, quando o Voalle recusou conexão por alguns minutos e os
  conjuntos pararam de vez): a conexão entra em espera crescente (2, 4, 8, 15 e
  30 min), o agendador não a tenta antes disso e o primeiro sucesso encerra a
  espera. Pausas antigas por fonte fora voltam sozinhas no boot e a cada 15 min.
  Ver `modules/sync/sourceOutage.ts`.
- **Divergiu, e agora?** Abra a linha: o dia que não bate aponta a causa. Linha
  a menos num dia com muitos registros de mesmo carimbo = empate na fronteira do
  lote (QLD-01); linha a mais = registro apagado na fonte (QLD-06); "nunca
  entram" = chave de criação vazia (QLD-07); "identidade não é única na fonte"
  = a identidade configurada junta linhas diferentes na compactação (QLD-04).
  Corrija a regra do conjunto ou recarregue (master) e use "Conciliar agora"
  para confirmar.

**Verificações contínuas (D-QLD-2 A)** — sem consultar a fonte, estado em
`dataset_checks`, alerta só na troca de estado (passou a falhar / voltou):

| Verificação | Quando | Falha quando |
|---|---|---|
| Prazo (`stale`) | a cada 15 min | de hora em hora parado > 2 h; diária > 26 h; agendamento parado > 3 intervalos (mín. 30 min) dentro da janela; calculado em cascata que não acompanhou um insumo por > 60 min |
| Volume (`volume`) | depois de cada carga de snapshot | caiu 20% ou mais em relação à carga anterior (tabelas com ≥ 1.000 linhas) |
| Identidade (`identity`) | depois de cada carga com identidade | identidade vazia no lake (qualquer modo) ou repetida (snapshot) |

Conjunto manual, pausado ou ao vivo não tem prazo cobrado.

---

## Padrão de nomes dos conjuntos (desde 19/11/2026)

`<camada>_<área>_<assunto>[_<período>]`, em minúsculas, com `_` entre as palavras.

- Camadas: `bronze` (cópia da fonte), `prata` (tratado), `ouro` (pronto para a área).
- Exemplos: `bronze_voalle_contratos`, `prata_cancelamentos_mensal`, `ouro_financeiro_titulos_abertos_diario`.
- Usamos sublinhado porque traço não vale como nome no SQL: só funciona entre aspas.
- Conjunto novo já nasce no padrão. Fonte vira `bronze_<fonte>_<nome>`; calculado e materializado de notebook viram `prata_<nome>`, a não ser que o nome dado já comece por uma camada.
- Os conjuntos antigos são renomeados em **Conjuntos › Padronizar nomes**, só por admin. Conjunto oficial, só o master renomeia. A tela sugere o nome e renomeia um a um ou todos de uma vez.
- O nome antigo vira **apelido** (`dataset_slug_aliases`, migration 046). Quem já usa o nome antigo continua funcionando: link, rota da API pública, SQL de calculado, notebook e modelo.
- Na renomeação, o escopo dos tokens, a API do construtor, o modelo e o filtro de aba de painel passam a usar o nome novo. A pasta do lake muda junto.
- Nenhum conjunto novo pode usar um nome que virou apelido.
- O conjunto não pode estar carregando nem na fila na hora de renomear.
- No Databricks, a camada vira o schema e sai do nome da tabela: `bronze.voalle_contratos`.
- O próximo envio de um conjunto renomeado é COMPLETO, para uma tabela com o nome novo. A tabela antiga fica lá e deve ser apagada à mão.
- Os arquivos antigos no bucket GCS também ficam, com o caminho antigo.

---

## Pacotes de conjuntos (catálogo como código, desde 19/11/2026)

Os pacotes ficam em **Conjuntos › Pacotes**: o admin vê, o master instala. Cada pacote está em
`apps/api/src/modules/catalog/packs/` e traz duas coisas:
- os calculados (prata e ouro), cada um com o próprio SQL;
- as tabelas de origem de que eles precisam.

**Instalar** (pode repetir sem medo: o que já existe não é mexido):
- **Fonte.** O pacote procura um conjunto que já copie aquela tabela, pelo schema e pela tabela, não pelo nome.
  - Se achar, reaproveita.
  - Se não achar, publica um `bronze_voalle_<tabela>` só com as colunas que o pacote usa (sem nome nem documento de pessoa), aplica a regra de carga do pacote e põe a carga na fila.
  - Se o conjunto já existe mas falta coluna, o pacote **não mexe nele**. O relatório avisa quais colunas faltam, e os calculados que dependem dele ficam de fora.
- **Calculado.** É criado com o nome do pacote, em **cascata**, e recalcula quando a fonte termina de carregar.
  - Nasce **privado**: libere o acesso por conjunto, para as áreas.
  - Até a primeira carga da fonte terminar, ele mostra "Aguardando a primeira carga de …". Não é erro do SQL.
- **Conexão.** O Voalle é lido pela conexão que já copia mais tabelas do schema `erp`. Se não houver nenhuma, usa a fonte embutida `elleven`.

**Onda 1:** 29 conjuntos, 2 prata e 27 ouro, sobre 10 tabelas do Voalle.
- Assuntos: base, receita, cancelamento e financeiro.
- O SQL foi validado contra o Voalle real em 19/11/2026:
  - base de 88.430 contratos;
  - cancelamento de 1,7 a 1,9% ao mês;
  - faturamento de ~R$ 9,8 mi por mês;
  - recebimento de ~R$ 9,3 mi por mês.

**Regras que valem para os próximos pacotes** (descobertas no banco):
- **Fatura.** Todo mês há dois títulos com o mesmo valor: a fatura `FAT…` (`bill_title_id` vazio) e os componentes que apontam para ela. As baixas também vêm em dobro. Conte só a fatura.
- **Tarifa de baixa.** A natureza `DF - TARIFA BAIXA DE TÍTULO` não é cobrança de cliente; fica fora.
- **Plano anual.** Gera as parcelas até 12 meses à frente, e isso explica o "a vencer" alto.
- **Instalação.** `approval_date` com stage 3. `created` é a venda, e `1000-01-01` é o "nulo" do Voalle.
- **Taxa de cancelamento.** Cancelados no mês ÷ base no fim do mês anterior. Ficam fora o lote (`FNC.CAN.020`), o duplicado (`OTR.CAN.006`), a telefonia (tipo 19) e quem nunca foi instalado.
- **Saldo antigo em aberto.** É quase todo de contrato já cancelado.

---

## 10. Recuperação rápida (ordem sugerida num incidente)

0. **Operar › Saúde da plataforma** — "Precisa de atenção agora" lista, do
   estado atual, cargas pausadas ou falhando, conciliações divergentes,
   verificações falhando, envio ao Databricks com erro, endpoints fora e disco
   acima do limite; "Falhas nas últimas 24 h" responde o que quebrou à noite.
1. `df -h /` — o disco está cheio?
2. Achou staging gigante? Confirme 0 syncs rodando → apague o `.jsonl` → reinicie.
3. Deploy falhando (container unhealthy)? Veja `docker logs datahub-api` — a API
   sobe em modo degradado se o banco estiver fora; embeddings nunca derrubam o boot.
4. Tabela pesando na fonte? Cadência → `Manual` e reconfigure para incremental.
5. Depois de estabilizar, defina `SYNC_MAX_ROWS` e revise `DUCK_MAX_CONCURRENCY`.
