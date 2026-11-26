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
- **Uso de disco**: a tela *Regras de atualização › Padronizar* mostra no topo o percentual
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
  **Operar › Regras de atualização › Padronizar**. Mexer na regra de um conjunto de
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
| `DQ_AUTOFIX_ENABLED` | `true` | Liga a correção automática da madrugada |
| `DQ_AUTOFIX_HOUR` | `1` | Hora da correção automática (só nessa hora; não recupera depois) |
| `DQ_AUTOFIX_SMALL` / `_MEDIUM` / `_LARGE` | `3` / `2` / `1` | Quantos divergentes por faixa, por noite (0 tira a faixa) |

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

Decisão D-QLD-3 do comitê (R4, 30/10/2026). Tela: **Operar › Saúde e qualidade › Qualidade dos dados**.

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
- **Onde os alertas aparecem:** em **Operar › Saúde e qualidade** (histórico
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
- **Correção automática da madrugada** (26/11/2026, `modules/quality/autofix.ts`):
  às `DQ_AUTOFIX_HOUR` (1h), o sistema faz sozinho o "Corrigir" da tela, que é
  a recarga completa com a conferência na mesma carga. Corrige até 3 pequenos,
  2 médios e 1 grande por noite e põe na fila do menor para o maior, então o
  grande vai por último. Só entra o que a recarga conserta:
  - a última conferência divergiu;
  - o conjunto é incremental;
  - a identidade é única na fonte e nenhuma linha fica fora por chave vazia;
  - não houve correção automática dele nos últimos 7 dias.

  Ficam fora os conjuntos `manual`, os pausados, os que estão carregando
  naquela hora e os **com piso de datas**. Nesses, a recarga respeita o piso e
  substitui o lake, então apagaria o histórico anterior a ele (QLD-05, aberto). Se a recarga não resolveu, a conferência diz isso numa nota, e o
  conjunto espera 7 dias (e alguém analisar) antes de nova tentativa. Na tela,
  essas conferências aparecem como "correção automática". O log do servidor
  diz quem entrou e quem ficou fora, com o motivo (`[qualidade] correção
  automática: …`).

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

**Fonte (tabela de banco), desde 24/11/2026:** usa o nome da TABELA no banco, sem mudança, tanto no nome técnico quanto no de exibição (ex.: `contracts`).
- Assim uma query copiada do banco (`select … from contracts`) roda no Data Hub sem ajuste.
- As colunas sempre foram fiéis: a chave de cada campo é a coluna da fonte.
- O nome só muda se outra conexão já tiver uma tabela com o mesmo nome. Aí entra `_2`, `_3`…
- O prefixo de schema (`erp.contracts`) ainda não é aceito no SQL daqui: tire o `erp.`.
- Fonte de API HTTP não tem tabela e segue a regra dos calculados.

**Calculado:** `<camada>_<área>_<assunto>[_<período>]`, em minúsculas, com `_` entre as palavras.

- Camadas: `prata` (tratado) e `ouro` (oficial ou pronto para a área).
- Exemplos: `prata_cancelamentos_mensal`, `ouro_financeiro_titulos_abertos_diario`.
- Usamos sublinhado porque traço não vale como nome no SQL: só funciona entre aspas.
- Calculado e materializado de notebook nascem `prata_<nome>`, a não ser que o nome dado já comece por uma camada.
- Entre 19/11 e 24/11, fonte nova nascia `bronze_<fonte>_<tabela>`. A tela "Padronizar nomes" agora devolve essas fontes ao nome da tabela, e o `bronze_…` fica como apelido.
- Os conjuntos antigos são renomeados em **Conjuntos › Padronizar nomes**, só por admin. Conjunto oficial, só o master renomeia. A tela sugere o nome e renomeia um a um ou todos de uma vez.
- O nome antigo vira **apelido** (`dataset_slug_aliases`, migration 046). Quem já usa o nome antigo continua funcionando: link, rota da API pública, SQL de calculado, notebook e modelo.
- Na renomeação, o escopo dos tokens, a API do construtor, o modelo e o filtro de aba de painel passam a usar o nome novo. A pasta do lake muda junto.
- Nenhum conjunto novo pode usar um nome que virou apelido.
- O conjunto não pode estar carregando nem na fila na hora de renomear.
- No Databricks, a camada vira o schema e sai do nome da tabela: `bronze.voalle_contratos`.
- O próximo envio de um conjunto renomeado é COMPLETO, para uma tabela com o nome novo. A tabela antiga fica lá e deve ser apagada à mão.
- Os arquivos antigos no bucket GCS também ficam, com o caminho antigo.

**Desde 24/11/2026: calculados com camada coerente e nome de exibição**
- **Nome técnico:** a camada do nome do calculado precisa concordar com o selo do catálogo.
  - Calculado oficial: `ouro`.
  - Calculado não oficial: `prata`, ou `ouro` quando já sai pronto para a área (como nos pacotes).
  - A primeira rodada sugeria `prata_` para todo calculado. Por isso ficaram oficiais com selo Ouro e nome `prata_`. A tela agora acusa e sugere `ouro_`.
- **Nome de exibição** (o que aparece em negrito): frase em português, com acentos e só a primeira letra maiúscula. Siglas e sistemas mantêm a grafia própria (SLAs, PPPoEs, Elleven, AutoISP). Ex.: "Protocolos de instalação - SLAs - técnicos - agendamentos".
  - A tela acusa o nome com cara de nome técnico (`cesta-produtos`), em CAIXA ALTA, Em Título, ou com "-cao" sem acento. Ela sugere o nome corrigido, editável antes de aplicar.
  - A sugestão não inventa palavra (não põe o "de" que faltou): revise antes de aplicar.
  - Qualquer admin troca o nome de exibição. O nome técnico de oficial continua só com o master.
- Para fonte, a tela mostra o nome da tabela fixo, sem campo para editar.
- O selo "Ouro" também vale para calculado `ouro_`. O cartão "Camada ouro" conta esses e diz quantos são oficiais.

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

**Carga incremental do Voalle = `modified` + `created`** (corrigido em 20/11/2026). O Voalle deixa `modified` vazio em muita linha. Com carga só por `modified`, ficariam de fora:

| Tabela | Linhas perdidas | Proporção | Desde |
|---|---|---|---|
| Baixas de títulos | 5,0 mi de 8,5 mi | 58% | 2023 |
| Eventos de contrato | 1,7 mi de 4,9 mi | 35% | 2023 |
| Títulos a receber | 70 mil | — | 2023 |
| Atendimentos | 147 mil | — | 2025 |
| Romaneios de material | 158 mil de 173 mil | 91% | 2025 |

Toda fonte de pacote com `modified` tem `created` como segunda chave. O motor faz uma passada por chave, e a linha com `modified` vazio entra pela de `created`. Os testes dos pacotes deixam `modified` vazio de propósito em linhas que eles conferem.

**Se a onda 1 já foi instalada antes desta correção**, as três cópias abaixo estão incompletas. A tela de Pacotes mostra "faltam colunas: created".
- `bronze_voalle_financial_receipt_titles`
- `bronze_voalle_contract_events`
- `bronze_voalle_financial_receivable_titles`

Em cada uma:
1. **Atualizar colunas**, incluindo `created`.
2. Em **Regras de atualização**, pôr `created` como segunda chave.
3. **Recarregar tudo**.

Os calculados recalculam sozinhos, pela cascata.

**Regras que valem para os próximos pacotes** (descobertas no banco):
- **Fatura.** Todo mês há dois títulos com o mesmo valor: a fatura `FAT…` (`bill_title_id` vazio) e os componentes que apontam para ela. As baixas também vêm em dobro. Conte só a fatura.
- **Tarifa de baixa.** A natureza `DF - TARIFA BAIXA DE TÍTULO` não é cobrança de cliente; fica fora.
- **Plano anual.** Gera as parcelas até 12 meses à frente, e isso explica o "a vencer" alto.
- **Instalação.** `approval_date` com stage 3. `created` é a venda, e `1000-01-01` é o "nulo" do Voalle.
- **Taxa de cancelamento.** Cancelados no mês ÷ base no fim do mês anterior. Ficam fora o lote (`FNC.CAN.020`), o duplicado (`OTR.CAN.006`), a telefonia (tipo 19) e quem nunca foi instalado.
- **Saldo antigo em aberto.** É quase todo de contrato já cancelado.

### Onda 2 · Campo: instalação, manutenção e agenda (20/11/2026)

**O que é:** 16 calculados, 2 prata e 14 ouro, sobre 13 tabelas do Voalle desde 2025. Contratos e pessoas são as mesmas cópias da onda 1, com as mesmas colunas, então as ondas podem ser instaladas em qualquer ordem.

**De onde vêm as regras:** dos painéis de Instalação e de Manutenção, já conferidos com a operação.
- **Instalado** = material alocado (`patrimony_packing_list_items.out_date`). Bate com a primeira conexão no AutoISP em 99,7% dos casos.
- **Universo de manutenção** = equipe ou catálogo de manutenção.
  - Saem as centrais (COR, CGR, Suporte, Corporativo, CAOC), os tipos administrativos e o cancelado.
  - O tempo até concluir é `conclusion_date − created`.

**Fontes com carga especial:**
- **Protocolos** (`assignment_incidents`) não têm data de alteração: cópia completa diária, só com 7 colunas (1,9 mi de linhas).
- **Agenda** (`service_desk_slots`): `modified` só existe depois da reserva, então tem duas chaves.
- **Histórico do app de campo** (`fsm_attendance_history`): relê 2 dias para pegar o fim dos trechos em andamento.

**Validação com dado real** (20/11/2026):
- 3.713 reparos em outubro, o mesmo número do painel de Manutenção;
- tempo mediano até concluir de ~15 h;
- coeficiente de ~0,10% da base por dia útil, contra a meta de 0,12%;
- recorrência de ~11%;
- ocupação da agenda de 54% a 64%.

**Diferença conhecida:** o painel de Manutenção também tira o colaborador que abre protocolo como cliente (regra pelo nome). Aqui não há nome de pessoa no lake. São ~5 protocolos por ano.

### Notebooks prontos do pacote (desde 20/11/2026)

O pacote também instala notebooks de análise (SQL + Python), definidos em `packs/onda1Notebooks.ts`.
- Nascem **privados**, no nome de quem instalou. Libere em "Acessos", junto com os conjuntos que eles leem.
- Um notebook só é criado se todos os conjuntos que as células SQL citam existirem.
- O SQL agrega no motor e o Python modela no navegador (Pyodide). A célula SQL entrega no máximo **500 linhas** ao Python.

**Onda 1:** 6 notebooks.
- Cancelamento: tendência, sazonalidade e previsão. Três métodos são testados nos 6 últimos meses e fica o que erra menos.
- Retenção por safra, vida média e receita esperada por contrato (Kaplan-Meier).
- Risco de cancelamento por perfil (regressão logística sobre segmentos).
- Curva de recebimento e perda esperada (chain-ladder).
- Ponte da receita contratada e projeção da base.
- Cidades e bairros com cancelamento fora do padrão (gráfico de funil).

**Validação.** Em 20/11/2026 os 6 rodaram no Chromium com o Pyodide 0.26.4 sobre dado real do Voalle, materializado num DuckDB temporário e servido com a mesma conversão JSON da rota.
- Resultados:
  - vida média de 3,8 anos e receita esperada de ~R$ 5 mil por contrato novo;
  - perda real de 5,6% do faturado nos meses completos;
  - 18 bairros de Canoas e Novo Hamburgo acima do esperado.
- O CI só confere que as células SQL passam pela rota (`pacotes.test.ts`). O Python não roda no CI.

**Armadilhas para quem escrever notebooks:**
- **Tipos.** Contagem (BIGINT) e decimal chegam ao Python como **texto**. A função `tabela()` do primeiro bloco converte. Colunas de data são reconhecidas pelo nome exato: `mes_vencimento` é data, `meses_de_casa` não.
- **Versões.** O Pyodide 0.26 traz pandas 2.2, matplotlib 3.5 e statsmodels 0.14: nada de API nova.
- **Código Python.** Escreva em `String.raw`: um `"\n"` num `print` viraria quebra de linha real e o Python recusaria.
- **Valor do contrato.** `prata_voalle_contratos.valor_mensal` é o valor **atual**, sem histórico. Uma ponte de receita feita com ele não mostra reajuste.

## SQL do Postgres nos calculados, notebooks e modelos (desde 26/11/2026)

A consulta copiada do Voalle roda como está. Antes de validar e executar, o SQL
passa por `modules/transform/pgCompat.ts`, que traduz só o que é do Postgres.
O SQL escrito para o DuckDB passa intacto.

- **Tabela com schema.** `erp.contracts` vira o conjunto de fonte daquela tabela,
  entre os que a pessoa alcança. Tabela fora do lake (ou sem acesso) recusa e
  explica. A mesma tabela em duas conexões pede o nome do conjunto.
- **Funções:**
  - `to_char` de data e de número, `to_date`, `to_timestamp(texto, molde)` e
    `to_number`;
  - `initcap` e `unaccent`;
  - `format('%s')`, `concat`/`concat_ws` e `div`;
  - `regexp_split_to_table`;
  - `json(b)_array_elements[_text]` e `json(b)_extract_path[_text]`;
  - `any('{a,b}')`, `::jsonb` e `::numeric` sem precisão.
- **Idioma:** o mesmo do Voalle (pt_BR). Milhar com ponto, vírgula decimal, `L` = R$,
  e nomes de mês e dia em português com `TM` (`TMMonth` → "Março"). Sem `TM`, os
  nomes saem em inglês, como no Postgres. O gabarito é a saída do próprio Voalle,
  fixada em `src/test/compatPostgres.test.ts`.
- **Corrigido porque dava resultado diferente sem erro:**
  - `~`, `~*`, `!~` e `!~*` procuram em qualquer parte do texto (no DuckDB o `~`
    exigia casar o texto inteiro);
  - `LIKE` com barra invertida escapa;
  - `::numeric` deixou de cortar em 3 casas;
  - número inteiro virando texto sai sem ".0" (`id::text`, `format`, `concat`).
    O lake guarda toda coluna numérica como DOUBLE.
- **Recusa com explicação, nunca aproxima:**
  - molde que não é texto fixo;
  - `TZ` e os sufixos `th`/`SP`;
  - campos numéricos `S`, `MI`, `PR`, `V`, `EEEE` e `RN`;
  - `format('%I')`/`%L`.
- **Diferenças que continuam:**
  - divisão entre inteiros dá decimal (`5/2` = 2,5; use `div(5, 2)`);
  - `id || 'x'` dá "1.0x", porque o `||` não é traduzido; use `concat`;
  - `SIMILAR TO` e `regexp_matches()` existem nos dois motores com significados
    diferentes;
  - os operadores `#>`/`#>>` não existem aqui; use `json(b)_extract_path`.

## Sugestões de melhoria (mesmo banco do Hub Apps, desde 21/11/2026)

O menu **Sugestões** mostra as sugestões do Data Hub gravadas em `DB_Hub_Apps` (MariaDB 10.0.11.171), nas mesmas três tabelas do Hub Apps e do Splitters. Cada sistema filtra pela coluna `app_id`.

**Para ligar**, na stack do Portainer:
- `HUB_APPS_MYSQL_HOST`, `HUB_APPS_MYSQL_USER` e `HUB_APPS_MYSQL_PASSWORD`. O `HUB_APPS_MYSQL_DATABASE` já vem com `DB_Hub_Apps`.
- `PLATFORM_SUGGESTIONS_APP_ID` com o id do Data Hub no cadastro de apps do Hub Apps (tabela `apps`). Em 21/11/2026 o Data Hub ainda **não** estava cadastrado: o cadastro é feito na administração do Hub Apps, e ele gera o id.
- `PLATFORM_SUGGESTIONS_READ_ONLY`:
  - `true` (padrão, como o Splitters em produção): a tela só mostra e manda sugerir, votar e comentar pelo Hub Apps. O usuário do banco precisa só de `SELECT`.
  - `false`: grava direto. O usuário precisa de `SELECT, INSERT, UPDATE, DELETE` nas três tabelas `platform_suggestion*`. Mudar status é só para admin.

**Sem configuração**, a tela avisa o que falta; não é erro.

**Diferença do Splitters:** o voto é identificado pelo e-mail. Cada sistema tem seu próprio projeto Firebase, então o uid muda de um sistema para outro, e o e-mail não.

---

## Data Hub dentro do Hub Apps (desde 21/11/2026)

O clique no card do Data Hub, no Hub Apps, abre o Data Hub na própria área do Hub (iframe), sem aba nova. O login acontece sozinho.

**Como a entrada funciona**
1. O Hub confere se a pessoa tem acesso ao app e emite um token de 5 minutos, assinado com o `SSO_JWT_SECRET` dele.
2. O quadro abre `https://data-hub…/?sso_token=…`. A tela tira o token da URL antes de qualquer outra coisa.
3. A API (`POST /api/v1/auth/hub`) confere o token antes de aceitar:
   - assinatura HS256;
   - validade;
   - `appId` igual a `HUB_APP_ID`;
   - domínio do e-mail;
   - uso único: o mesmo token não entra duas vezes.
4. Se tudo bate, a API devolve uma sessão de 8 horas do Data Hub.
   - O papel (viewer, editor, admin) vem do banco do Data Hub, igual ao login pelo Google.
   - A sessão fica no `sessionStorage` do quadro. Uma aba aberta direto no Data Hub não herda essa sessão.

**Para ligar**

Na stack do Data Hub, preencha:
- `HUB_SSO_SECRET`: o **mesmo** valor do `SSO_JWT_SECRET` da stack do Hub Apps.
- `HUB_APP_ID`: o id do Data Hub no cadastro de apps do Hub. É o mesmo de `PLATFORM_SUGGESTIONS_APP_ID`.

No Hub Apps, vá em Administração › Apps › Data Hub e marque:
- **SSO — passar token**;
- **Abrir dentro do Hub**. Essa opção depende da migration 20 do hub-api, que é aplicada sozinha quando ele sobe.

**Bloquear o acesso por fora do Hub (`HUB_ONLY=true`)**
- Quem tenta entrar direto pelo Google recebe `403 HUB_ONLY`, **master inclusive**. A tela de login mostra só "Acesse pelo Hub Apps", sem o botão do Google. Sessão do Google já aberta também para de valer.
- O master entra pelo Hub como qualquer um e segue master dentro do sistema. **Porta de emergência** (Hub fora): `HUB_ONLY=false` na stack + redeploy.
- A API pública (`/api/public/v1`, com token de API) e o `/api/health` não mudam.
- Se `HUB_SSO_SECRET` ou `HUB_APP_ID` estiver vazio, `HUB_ONLY` é ignorado e o log de subida avisa. Sem esses dois valores ninguém entraria pelo Hub, então ligar o bloqueio trancaria todo mundo.
- Ordem segura: primeiro ligue a entrada pelo Hub e confira que ela funciona. Depois mude `HUB_ONLY` para `true`.

**Painéis (dashia) com o modo só pelo Hub (`DASHIA_SSO_SECRET`)**
- A cada abertura do menu Painéis, a tela pede `POST /api/v1/dashia/sso-token` e abre o dashia com `?sso_token=`. O token (HS256, 300 s, uso único lá) leva `email`, `name` e `via` (origem da sessão do Data Hub: `hub` ou `google`).
- `DASHIA_SSO_SECRET` aqui = `DATAHUB_SSO_SECRET` na stack do dashia (mesmo valor, 32+ caracteres, diferente do `HUB_SSO_SECRET`). Nunca vai para o front.
- Vazio ou curto: a rota responde `503 DASHIA_SSO_OFF` e o quadro abre o dashia sem token, como antes.
- Ordem segura: preencher `DASHIA_SSO_SECRET` (aqui) e `DATAHUB_SSO_SECRET` (dashia) com o mesmo valor, publicar as duas stacks e só então ligar `HUB_ONLY` no dashia. Com `HUB_ONLY` lá, só `via: hub` entra.

**Quem pode exibir o Data Hub num quadro**

A lista fica no `docker/nginx.conf`, no cabeçalho `Content-Security-Policy: frame-ancestors`. Hoje ela libera o próprio Data Hub, `hub-apps.sebratel.net.br` e `hub-apps-staging.sebratel.net.br`.

O dashia, que aparece em Painéis, precisa da **mesma** lista no nginx dele. O `frame-ancestors` vale para todos os quadros acima, não só para o imediato.

**Sintomas e causas**

| Sintoma | Causa |
|---|---|
| Área em branco no Hub | Falta o domínio do Hub no `frame-ancestors`. |
| "O acesso pelo Hub Apps não está configurado" | Falta `HUB_SSO_SECRET` ou `HUB_APP_ID`. |
| "Token do Hub inválido" | O segredo não é igual ao `SSO_JWT_SECRET` do Hub. |
| "emitido para outro aplicativo" | `HUB_APP_ID` errado. |
| "Este link de acesso já foi usado" | O token foi reaproveitado. Recarregar no Hub resolve, porque emite um token novo. |

---

## 10. Recuperação rápida (ordem sugerida num incidente)

**Saúde da API (desde 24/11/2026, D-12):**
- `GET /api/health` confere o banco de metadados ao vivo e responde **503** com `metadataDb: "offline"` quando ele está fora. É esse endereço que o Zabbix deve vigiar (M-02).
- `GET /api/health/live` só diz que o processo está de pé. É o do healthcheck do contêiner: com o estrito ali, um deploy com o banco fora deixaria o `datahub-web` sem subir.
- Banco fora no boot: a API sobe degradada e um vigia tenta de novo a cada 15 s. Quando o banco volta, ela completa o boot sozinha (caches, conexões, masters). Não precisa reiniciar.
- Banco caindo com a API no ar: as rotas que dependem dele respondem 503 até ele voltar. Quem precisa de papel (editor, admin) recebe "Banco de metadados indisponível", e não "sem permissão".

0. **Operar › Saúde e qualidade** — "Precisa de atenção agora" lista, do
   estado atual, cargas pausadas ou falhando, conciliações divergentes,
   verificações falhando, envio ao Databricks com erro, endpoints fora e disco
   acima do limite; "Falhas nas últimas 24 h" responde o que quebrou à noite.
1. `df -h /` — o disco está cheio?
2. Achou staging gigante? Confirme 0 syncs rodando → apague o `.jsonl` → reinicie.
3. Deploy falhando (container unhealthy)? Veja `docker logs datahub-api` — a API
   sobe em modo degradado se o banco estiver fora; embeddings nunca derrubam o boot.
4. Tabela pesando na fonte? Cadência → `Manual` e reconfigure para incremental.
5. Depois de estabilizar, defina `SYNC_MAX_ROWS` e revise `DUCK_MAX_CONCURRENCY`.
