# SQL de conjuntos calculados

Consultas DuckDB para colar em **Conjuntos › Novo calculado**. Cada arquivo é
autoexplicativo; este README reúne só o que vale para **qualquer** calculado
deste lake — as armadilhas que não dão erro, só resultado errado.

| Arquivo | O que é |
|---|---|
| `tecnicos-produtividade-detalhe.sql` | conjunto: um protocolo por papel (instalador/auxiliar) |
| `tecnicos-produtividade.sql` | conjunto: o agregado por técnico **e mês**, lendo o detalhe |
| `tecnicos-produtividade-diagnostico.sql` | descartável: volume dos conjuntos e janelas de data |
| `tecnicos-produtividade-diagnostico-2.sql` | descartável: onde um funil de junções zera |
| `tecnicos-produtividade-diagnostico-3.sql` | descartável: por que o técnico auxiliar não resolve |

---

## 1. Todo número deste lake é DOUBLE

Medido no catálogo real: `assignments.id`, `assignment_incidents.assignment_id`,
`incident_types.id` e `incident_type_id` chegam **todos como `DOUBLE`**. A
ingestão passa por JSONL e o DuckDB infere ponto flutuante.

Duas consequências, e nenhuma delas levanta erro:

```sql
CAST(12.0 AS VARCHAR)                                  -- '12.0', não '12'
regexp_replace(CAST(100001.0 AS VARCHAR), '[^0-9]','','g')  -- '1000010', com um zero a mais
```

A primeira fez a produtividade de técnicos voltar **vazia**: `'12.0' IN ('12')`
é falso, e as 249 mil linhas do tipo 12 sumiram sem aviso. A segunda teria
corrompido a chave que liga o protocolo à tarefa auxiliar.

**Regra:** compare id como número, nunca por texto.

```sql
-- errado                                   -- certo
CAST(it.id AS VARCHAR) IN ('12','15')       TRY_CAST(it.id AS BIGINT) IN (12, 15)
```

Para transformar um id em texto limpo (rótulo, concatenação, chave de junção),
passe pelo inteiro primeiro:

```sql
coalesce(CAST(TRY_CAST(x AS BIGINT) AS VARCHAR), CAST(x AS VARCHAR))
```

Booleano tem o mesmo problema ao contrário: `outsourced` pode chegar como
`true`, `'true'` ou `1.0`. As três formas passam por:

```sql
coalesce(TRY_CAST(CAST(x AS VARCHAR) AS BOOLEAN), TRY_CAST(x AS DOUBLE) <> 0, false)
```

## 2. O lake só tem as colunas publicadas

Um calculado enxerga os **campos publicados** do conjunto, não a tabela de
origem inteira. Antes de escrever, confira na tela do conjunto se as colunas
que o SQL usa estão lá — `description`, `tags` e flags raramente entram numa
publicação padrão.

## 3. Diferenças do Postgres que mordem

| Postgres | DuckDB | Por quê |
|---|---|---|
| `initcap(x)` | `array_to_string(list_transform(string_split(lower(x),' '), w -> upper(w[1]) \|\| w[2:]), ' ')` | `initcap` **não existe** no DuckDB |
| `x::numeric / y` | `x::DOUBLE / y` | o NUMERIC padrão é `DECIMAL(18,3)` e a divisão perde casas antes do `ROUND` |
| `ORDER BY d DESC` | `ORDER BY d DESC NULLS LAST` | o padrão de nulos difere entre os dois em `DESC` |
| `x::bigint` | `TRY_CAST(x AS BIGINT)` | um valor ruim derruba a materialização inteira em vez de virar nulo |
| `'\D'` | `'[^0-9]'` | iguais para o RE2, e `[^0-9]` não vira armadilha dentro de código JS (lá `'\D'` numa string vira `D`) |

`FILTER`, `IS DISTINCT FROM`, `COUNT(DISTINCT)`, funções de janela e CTE dentro
de subconsulta funcionam sem mudança. A última importa: o hub embrulha todo
calculado em `select * from ( seu SQL ) as __derivado`.

## 4. O que o guard recusa

`validateTransformSql` exige começar com `SELECT`/`WITH`, proíbe `;` no meio e
barra palavras de escrita (`create`, `into`, `copy`, `execute`…) e funções que
alcançam o sistema de arquivos (`read_parquet`, `glob`, `attach`, `pragma`…).
Referencie conjuntos pelo **apelido com underscore** — a lista fica no painel
direito da tela.

## 5. Agregado precisa de uma coluna de tempo

Um calculado agregado só por entidade (técnico, cliente, equipe) não dá recorte
de período: a data foi embora no `GROUP BY`. Inclua a competência no grão desde
o início — custa pouco (96 técnicos × 12 meses são ~1.000 linhas) e é a
diferença entre um painel filtrável e um número único.

E guarde os **componentes**, não a razão. `protocolos` e `dias_trabalhados`
somam entre meses; `media_por_dia` não. Num período de vários meses a média é
`sum(protocolos) / sum(dias_trabalhados)` — a média das médias mensais pesa
igual quem trabalhou 2 dias e quem trabalhou 20.

## 6. Cadência: cascata nem sempre

Um calculado que cita 10 fontes, em **cascata**, recalcula a cada sincronização
de qualquer uma delas. Com as fontes em cadência de minutos, isso vira recálculo
quase contínuo. Cascata é ótima quando o recálculo é barato — é o caso do
agregado, que lê um conjunto só. Para o detalhe pesado, prefira diária ou um
agendamento noturno.
