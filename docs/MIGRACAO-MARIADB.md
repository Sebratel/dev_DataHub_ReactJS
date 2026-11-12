# Metadados no MariaDB (D-DSP-4)

O banco de **metadados** do Data Hub (catálogo, usuários, permissões, painéis,
auditoria, uso) pode rodar no Postgres de sempre ou no MariaDB corporativo. O
**lake** (Parquet + DuckDB) não muda.

| | Postgres (hoje) | MariaDB (destino) |
|---|---|---|
| Onde | serviço `datahub-db` da stack | `10.0.11.171:3306`, banco `DB_DataHub` |
| Usuário | `datahub` | `datahub_app`, só a partir de 186.219.134.246 e .247, acesso só a `DB_DataHub` |
| Variáveis | `DATAHUB_DB_*` | `DATAHUB_MARIA_*` |
| Escolha | `DATAHUB_DB_DRIVER=postgres` (padrão) | `DATAHUB_DB_DRIVER=mariadb` |

As duas configurações convivem na stack. **Virar e voltar é trocar só o
`DATAHUB_DB_DRIVER`.** O Postgres não é alterado pela virada nem pelo copiador.

## Como funciona

- O código continua escrevendo SQL de Postgres. Com o driver `mariadb`, cada
  consulta passa por `src/db/mariadb/translate.ts` (tradução mecânica, por
  tokens) e `src/db/mariadb/client.ts` (cliente com a interface do `pg.Pool`, que
  devolve as linhas no formato do driver do Postgres). O que não é mecânico o
  tradutor recusa com o nome da construção, e a consulta deve ser reescrita num
  SQL que rode nos dois bancos.
- O esquema do MariaDB está em `src/db/migrations-mariadb/`: `000-base.sql`
  equivale às migrations 001 a 043, e `000-seed.sql` traz o tenant e os papéis
  de um banco novo.
- **Toda migration nova precisa existir nas duas pastas, com o mesmo nome.**
  Sem a versão MariaDB, a API não sobe com o driver `mariadb` e o
  `mariadb:smoke` falha no CI.
  - O MariaDB não desfaz DDL dentro de transação, então escreva a migration de
    forma idempotente (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
- O CI roda a suíte inteira nos dois bancos: o job `api` usa Postgres e o job
  `api-mariadb` usa MariaDB 10.11.10, a versão do servidor corporativo. Uma
  consulta nova que só funcione no Postgres quebra ali, e não no dia da virada.
- `npm run mariadb:scan` varre o código atrás de consultas que o tradutor
  recusaria.

## Copiador: `npm run meta:copy`

`src/scripts/metaCopy.ts` copia do Postgres para o MariaDB e confere o
resultado. No servidor, rode de dentro do container, que alcança os dois bancos:

```sh
docker exec datahub-api npx tsx apps/api/src/scripts/metaCopy.ts              # copia e confere
docker exec datahub-api npx tsx apps/api/src/scripts/metaCopy.ts --conferir   # só confere
```

**Leitura do Postgres.** Uma única transação `REPEATABLE READ READ ONLY`: é uma
foto consistente de todas as tabelas, tirada no mesmo instante, e o banco
recusa qualquer escrita nela.

**Pré-voo.** Antes de escrever qualquer coisa, o copiador confere e para se
algo não bater:
- as migrations aplicadas são as mesmas nos dois bancos;
- as colunas são as mesmas em todas as tabelas;
- nenhum texto da origem é maior que a coluna `VARCHAR` de destino.

**Cópia.** Datas vão como texto UTC com microssegundos, JSON e arrays vão como
o texto do próprio Postgres, e os ids são preservados.

**Conferência.** Três verificações:
- contagem de linhas de cada tabela;
- impressão digital do conteúdo: o hash de cada linha, somado;
- leitura **pelo app**: uma amostra de até 2.000 linhas por tabela, lida pelo
  driver do Postgres e pelo cliente MariaDB e comparada objeto a objeto, tipo a
  tipo.

**Proteções.**
- Só recria tabelas que o próprio copiador criou; elas ficam marcadas em
  `_copia_postgres`. Se houver tabela de outra origem no banco, ele para.
- Se a API já gravou no MariaDB depois da última cópia, ele para em vez de
  apagar o que foi feito desde a virada.

**Ensaio local.** Origem: um clone do banco de desenvolvimento com 50 mil linhas
de auditoria e casos difíceis (acentos, emoji, barras, aspas, JSON aninhado,
arrays, `bigint` acima de 2^53, vetor de 384 posições, texto de 200 KB, datas
com microssegundos). Resultado: as 44 tabelas idênticas, com a cópia em cerca de
2 s.

## Roteiro da virada

### Antes do dia

1. Merge na `main` do código que traz o driver. Nada muda em produção: o padrão
   continua `postgres`.
2. Na stack do Portainer, preencher as variáveis do MariaDB. Elas ficam
   inertes enquanto o driver for `postgres`:
   ```
   DATAHUB_MARIA_HOST=10.0.11.171
   DATAHUB_MARIA_PORT=3306
   DATAHUB_MARIA_DATABASE=DB_DataHub
   DATAHUB_MARIA_USER=datahub_app
   DATAHUB_MARIA_PASSWORD=<do cofre>
   ```
3. **Ensaio em produção, sem parar nada.** Rodar o copiador (`metaCopy.ts`)
   com a API no ar. O resultado precisa terminar em `TUDO CONFERE`.
   - Isso confirma que o servidor alcança o MariaDB a partir do IP liberado e
     mede o tempo real da cópia.
   - Pode repetir quantas vezes quiser: a cada execução ele recria a cópia
     anterior.
4. Medir quanto tempo a cópia levou e marcar a janela.
   - Ensaio de 12/11/2026 no servidor: 44 tabelas, cerca de 690 mil linhas
     (`sync_runs` 341 mil, `api_call_metrics` 339 mil). A cópia levou uns 35 s,
     e a cópia com a conferência ficou em cerca de 1 minuto.

### No dia (janela de uns 10 minutos)

O copiador roda dentro do container da API, e a API normal grava sozinha,
porque o agendador de cargas não para. Por isso a janela usa o **modo
manutenção** (`DATAHUB_MANUTENCAO=true`): a API sobe sem migrations, sem
agendador e sem rotas, e responde 503 para quem chamar. O Postgres fica parado
no tempo e o container continua de pé para o copiador.

1. Na stack, colocar `DATAHUB_MANUTENCAO=true` e clicar em **Update the stack**.
   - O log deve mostrar `[api] MODO MANUTENÇÃO`.
   - As telas e a API pública passam a responder 503 até o fim da janela.
2. No Console do `datahub-api`, rodar o copiador e conferir que terminou em
   `TUDO CONFERE`. Se aparecer qualquer `DIFERENTE` ou `PAROU`, não vire: tire
   o `DATAHUB_MANUTENCAO` e volte ao normal com `postgres`.
3. Na stack, mudar `DATAHUB_DB_DRIVER=mariadb` e `DATAHUB_MANUTENCAO=false`, e
   clicar em **Update the stack**.
   - O log deve mostrar `[db] banco datahub pronto (mariadb 10.0.11.171/DB_DataHub).`
   - A fonte da telemetria muda sozinha:
     `[api-metrics] fonte da telemetria agora em mariadb (DB_DataHub).`
4. Fazer o teste rápido: login, catálogo, abrir um painel, rodar uma consulta,
   ver a Auditoria e a Saúde da plataforma.
5. **Manter o serviço `datahub-db` e o volume dele.** É a volta.

### Voltar

- **Antes de qualquer gravação no MariaDB:** basta `DATAHUB_DB_DRIVER=postgres`.
  Nada se perde.
- **Depois de gravações:** voltar para o Postgres perde o que foi gravado no
  MariaDB desde a virada (logins, edições, auditoria, uso). Não há cópia no
  sentido inverso. A volta precisa ser decidida já sabendo disso.

## Diferenças conhecidas (e o que foi feito)

| Ponto | Postgres | MariaDB | Tratamento |
|---|---|---|---|
| Vetor da busca semântica | pgvector (`<=>`) | não existe na 10.11 | distância de cosseno em memória (`nearestInProcess`); o tradutor recusa `<=>` |
| Data/hora | `timestamptz` | `DATETIME(6)` em UTC | sessão `+00:00`; texto ISO com fuso convertido quando vai para coluna de data |
| Telemetria como fonte (`datahub-meta`) | sessão da fonte no fuso local | DATETIME não tem fuso | `api_call_metrics.created_at` vira `TIMESTAMP(6)` (044) e a sessão da fonte usa o fuso local: leitura, filtro incremental e "por dia" da conciliação iguais aos do Postgres. Limite do TIMESTAMP: 2038. |
| JSON e arrays | `jsonb`, `text[]` | `JSON` (texto validado) | o cliente devolve objeto e array, como o driver do Postgres |
| Índice único parcial | `where …` | não existe | coluna gerada invisível + `UNIQUE` (provedor padrão, conciliação pendente) |
| `UPDATE … RETURNING` | existe | não existe | emulado em 3 passos numa transação |
| Comparação de texto | binária | `utf8mb4_nopad_bin` | mesma regra: maiúscula ≠ minúscula e `'a' ≠ 'a '` |
| NULL na ordenação | último no ASC | primeiro no ASC | o tradutor acrescenta a chave `x IS NULL` (dispensada em coluna NOT NULL) |
| DDL em transação | desfaz | não desfaz | migrations idempotentes |
| FK + CHECK no agendamento | `ON DELETE SET NULL` | não pode com o CHECK | FK sem ação; o código já desvincula antes de excluir |
| Ordem alfabética | colação do servidor | binária | listas por nome podem ordenar maiúsculas antes de minúsculas |

## Ainda depende de decisão ou acesso

- Medir o tamanho real dos metadados de produção, com
  `docs/sql/tamanho-metadados.sql` (só leitura).
- Testar o login do `datahub_app` a partir do servidor, que é o primeiro passo
  do ensaio.
- Backup do `DB_DataHub` no MariaDB corporativo: o servidor está com
  `log_bin=OFF`, então não há recuperação ponto a ponto. Precisa de rotina de
  dump combinada com quem administra o banco.
- `scripts/rag.ts` (playground) continua só para Postgres.
