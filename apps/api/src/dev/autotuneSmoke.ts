// Smoke da padronização de atualização. Roda sem banco e sem fonte: valida as
// quatro coisas que não dá para conferir só lendo o código —
//   1. as consultas de catálogo passam pelo guard read-only (a lista de
//      palavras proibidas é ampla: "create", "into", "cluster"… e uma consulta
//      a information_schema esbarra nelas com facilidade);
//   2. o parser de indexdef do Postgres extrai as colunas certas (é texto
//      livre: índice parcial, expressão, DESC, opclass);
//   3. a compactação condicional decide certo — o SQL da sondagem roda no
//      DuckDB de verdade, sobre Parquet de verdade;
//   4. o motor de decisão escolhe a regra certa em cada formato de tabela que
//      existe nas fontes (created+modified, só PK, view, sem identidade…).
// Uso: npm run autotune:smoke --workspace apps/api
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkReadOnly } from '../core/guard.js'
import { duckQuery } from '../modules/query/duck.js'
import { recencyExpression, excedeTeto } from '../modules/sync/ingest.js'
import { decidePlan, type Field, type PlanBase } from '../modules/sync/autotune.js'
import type { TableKeys, IndexInfo } from '../connectors/introspect.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── 1. Guard sobre as consultas de catálogo ──────────────────────────────
const CATALOG_SQL: [string, string][] = [
  ['pg: tipo do objeto',
    `select table_type from information_schema.tables where table_schema = $1 and table_name = $2`],
  ['pg: chave primária',
    `select kcu.column_name, kcu.ordinal_position
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
        and kcu.constraint_schema = tc.constraint_schema
      where tc.table_schema = $1 and tc.table_name = $2
        and tc.constraint_type = 'PRIMARY KEY'
      order by kcu.ordinal_position`],
  ['pg: índices',
    `select indexname, indexdef from pg_indexes where schemaname = $1 and tablename = $2`],
  ['mysql: índices',
    `select index_name, seq_in_index, column_name, non_unique
       from information_schema.statistics
      where table_schema = ? and table_name = ?
      order by index_name, seq_in_index`],
]
console.log('\n── guard read-only nas consultas de catálogo ──')
for (const [name, sql] of CATALOG_SQL) {
  const r = checkReadOnly(sql)
  check(name, r.ok, r.ok ? '' : r.reason)
}

// ── 2. Parser de indexdef ────────────────────────────────────────────────
const { parseIndexDefForTest } = await import('../connectors/introspect.js')
console.log('\n── parser de indexdef (Postgres) ──')
const CASES: [string, string, { unique: boolean; columns: string[] } | null][] = [
  ['índice simples',
    'CREATE INDEX idx_a ON public.t USING btree (created_at)',
    { unique: false, columns: ['created_at'] }],
  ['único composto',
    'CREATE UNIQUE INDEX t_pkey ON public.t USING btree (tenant_id, id)',
    { unique: true, columns: ['tenant_id', 'id'] }],
  ['parcial (WHERE) não vaza para as colunas',
    'CREATE INDEX idx_b ON public.t USING btree (modified_at) WHERE (ativo = true)',
    { unique: false, columns: ['modified_at'] }],
  ['DESC/NULLS e opclass ficam de fora',
    'CREATE INDEX idx_c ON public.t USING btree (created_at DESC NULLS LAST, nome text_pattern_ops)',
    { unique: false, columns: ['created_at', 'nome'] }],
  ['expressão é descartada (não serve de keyset)',
    'CREATE INDEX idx_d ON public.t USING btree (lower(email))',
    null],
  ['coluna entre aspas',
    'CREATE UNIQUE INDEX idx_e ON public.t USING btree ("Id")',
    { unique: true, columns: ['Id'] }],
]
for (const [name, def, expected] of CASES) {
  const got = parseIndexDefForTest(def)
  const same = JSON.stringify(got) === JSON.stringify(expected)
  check(name, same, same ? '' : `esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(got)}`)
}

// ── 3. Sondagem da compactação, no DuckDB de verdade ─────────────────────
console.log('\n── compactação condicional (DuckDB) ──')
const dir = mkdtempSync(join(tmpdir(), 'autotune-smoke-')).replace(/\\/g, '/')
try {
  const probe = async (keys: string[]) => {
    const group = keys.map((k) => `"${k}"`).join(', ')
    const { rows } = await duckQuery(
      `select 1 as dup from read_parquet('${dir}/*.parquet') group by ${group} having count(*) > 1 limit 1`,
    )
    return rows.length > 0
  }

  // Lote só com linhas NOVAS: nenhuma identidade repetida → não compacta.
  await duckQuery(
    `copy (select * from (values (1,'a'),(2,'b'),(3,'c')) as t(id, nome))
       to '${dir}/part-1.parquet' (format parquet)`,
  )
  check('lote só com linhas novas → dispensa compactação', (await probe(['id'])) === false)

  // Segundo lote traz a versão nova da linha 2 → identidade repetida → compacta.
  await duckQuery(
    `copy (select * from (values (2,'b2'),(4,'d')) as t(id, nome))
       to '${dir}/part-2.parquet' (format parquet)`,
  )
  check('lote com linha editada → exige compactação', (await probe(['id'])) === true)

  // Identidade COMPOSTA: (id, nome) não repete, ainda que id repita.
  check('identidade composta distingue as versões', (await probe(['id', 'nome'])) === false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── 3a. O disjuntor conta POR PASSADA ───────────────────────────────────
// Um conjunto real de 15,9 milhões de linhas entrou em laço: toda carga
// completa lia a tabela duas vezes (uma por chave), somava ~31,7 milhões e
// estourava o teto de 30 milhões — dimensionado para "a maior tabela + folga",
// sem contar com a duplicação. Abortava depois de ~3h de leitura na produção,
// e o agendador tentava de novo no ciclo seguinte. Sete vezes por dia.
console.log('\n── disjuntor de carga em fuga ──')
{
  const TETO = 30_000_000
  const TABELA = 15_882_876 // linhas reais do conjunto que travou

  check('o TOTAL das duas passadas estouraria o teto',
    excedeTeto(TABELA * 2, TETO), `${(TABELA * 2).toLocaleString('pt-BR')} > ${TETO.toLocaleString('pt-BR')}`)
  check('cada passada, sozinha, cabe',
    !excedeTeto(TABELA, TETO), `${TABELA.toLocaleString('pt-BR')} por chave`)
  // E o que o disjuntor existe para pegar continua sendo pego: uma leitura em
  // fuga não tem limite, então estoura em qualquer contagem.
  check('carga em fuga continua sendo abortada', excedeTeto(TETO + 1, TETO))
  check('teto zero desliga o disjuntor', !excedeTeto(999_999_999, 0))
}

// ── 3b. Recência da compactação: tipos não podem se misturar ────────────
// Quando a tabela de origem não tem coluna de criação, a 1ª chave vira o `id`
// numérico. Juntá-lo à 2ª chave num greatest(id, updated_at) faz o DuckDB
// recusar a consulta inteira — "Cannot combine types of DOUBLE and TIMESTAMP" —
// e a compactação falha em TODA execução. Foi o que travou um conjunto real em
// 50 execuções seguidas, sem nunca sincronizar.
console.log('\n── recência da compactação (DuckDB) ──')
const dir2 = mkdtempSync(join(tmpdir(), 'recency-smoke-')).replace(/\\/g, '/')
try {
  // Duas versões da MESMA linha: a antiga nunca editada (updated_at nulo) e a
  // nova, editada. A compactação tem de ficar com a editada.
  await duckQuery(
    `copy (
       select * from (values
         (1, 'antiga', cast(null as timestamp)),
         (1, 'nova',   timestamp '2026-09-21 10:00:00'),
         (2, 'unica',  cast(null as timestamp))
       ) as t(id, valor, updated_at)
     ) to '${dir2}/part-1.parquet' (format parquet)`,
  )

  const compactar = async (keys: { key: string; isDate: boolean }[]) => {
    const { rows } = await duckQuery(
      `select * exclude (__rn) from (
         select *, row_number() over (
           partition by "id" order by ${recencyExpression(keys)} desc nulls last
         ) as __rn
         from read_parquet('${dir2}/*.parquet')
       ) where __rn = 1 order by id`,
    )
    return rows as { id: number; valor: string }[]
  }

  // O caso do bug: 1ª chave numérica + 2ª chave temporal.
  const misto = [{ key: 'id', isDate: false }, { key: 'updated_at', isDate: true }]
  check('expressão não mistura número com data',
    !recencyExpression(misto).includes('greatest'), recencyExpression(misto))
  try {
    const linhas = await compactar(misto)
    check('compacta sem erro de tipo e mantém a versão editada',
      linhas.length === 2 && linhas[0].valor === 'nova',
      linhas.map((l) => `${l.id}:${l.valor}`).join(', '))
  } catch (e) {
    check('compacta sem erro de tipo e mantém a versão editada', false, (e as Error).message)
  }

  // O caso comum (duas datas) não pode ter regredido: as duas continuam valendo.
  const duasDatas = [{ key: 'updated_at', isDate: true }, { key: 'criado_em', isDate: true }]
  check('duas chaves temporais continuam usando greatest',
    recencyExpression(duasDatas) === 'greatest("updated_at", "criado_em")',
    recencyExpression(duasDatas))

  // Só chave numérica (sem data nenhuma): usa ela mesma, sem greatest.
  check('chave única numérica é usada sozinha',
    recencyExpression([{ key: 'id', isDate: false }]) === '"id"')
  check('sem chave nenhuma devolve NULL', recencyExpression([]) === 'NULL')
} finally {
  rmSync(dir2, { recursive: true, force: true })
}

// ── 4. Motor de decisão ─────────────────────────────────────────────────
console.log('\n── escolha da regra por formato de tabela ──')

const f = (sourceColumn: string, type: string, key = sourceColumn): Field => ({ key, sourceColumn, type })

function keysOf(opts: {
  pk?: string[]
  uniques?: { name: string; columns: string[] }[]
  indexes?: string[][]
  isView?: boolean
}): TableKeys {
  const idx: IndexInfo[] = []
  if (opts.pk?.length) idx.push({ name: 'pk', unique: true, primary: true, columns: opts.pk })
  for (const u of opts.uniques ?? []) idx.push({ ...u, unique: true, primary: false })
  for (const cols of opts.indexes ?? []) idx.push({ name: `i_${cols[0]}`, unique: false, primary: false, columns: cols })
  return {
    primaryKey: opts.pk ?? [],
    uniques: idx.filter((i) => i.unique).sort((a, b) => a.columns.length - b.columns.length),
    indexes: idx,
    leadingColumns: new Set(idx.map((i) => i.columns[0])),
    isView: !!opts.isView,
  }
}

const baseOf = (over: Partial<PlanBase> = {}): PlanBase => ({
  datasetId: 'd1', slug: 'conj', name: 'Conjunto', connectionId: 'elleven',
  schema: 'public', table: 't', rowCount: 1000,
  // Por padrão: campos batendo com a fonte e sincronização saudável — o
  // cenário normal, para que cada caso abaixo mude só o que quer testar.
  drift: { missing: [], extra: [], checked: true },
  health: {
    lastSuccessAt: '2026-09-18T10:00:00.000Z', lastRunAt: '2026-09-18T10:00:00.000Z',
    lastError: null, failuresSinceSuccess: 0, failing: false, pausedReason: null,
  },
  // A necessidade de recarga é decidida fora de decidePlan (depende do tipo da
  // conexão e do histórico de execuções), então aqui entra um valor neutro.
  reload: { needed: false, reason: '', lakeBytes: null, estimatedMinutes: null },
  current: {
    mode: 'snapshot', incrementalKey: null, incrementalKey2: null,
    dedupeKeys: [], cadence: 'daily', watermarkLagMinutes: 0,
  },
  ...over,
})

// Cada caso abaixo vive no proprio escopo para poder reusar o nome `p`.
// Um bloco nu (`{ ... }`) faria o mesmo, mas num arquivo sem ponto e virgula
// ele gruda no `})` da linha anterior e o TypeScript passa a ler o objeto
// como lista de parametros de uma arrow -- erro de sintaxe a 10 linhas de
// distancia de onde parece estar. Uma funcao nomeada nao tem essa aresta.
const cenario = (fn: () => void): void => fn()

// O caso que motivou a migration 029: created + modified, PK numérica, tudo
// indexado. É o desenho em que a cadência de minutos realmente cabe.
cenario(() => {
  const p = decidePlan(
    baseOf(),
    [f('id', 'number'), f('nome', 'text'), f('created_at', 'date'), f('updated_at', 'date')],
    keysOf({ pk: ['id'], indexes: [['created_at'], ['updated_at']] }),
  )
  check('created + modified + PK indexados → duas chaves, identidade e minutos',
    p.proposed?.incrementalKey === 'created_at' && p.proposed?.incrementalKey2 === 'updated_at'
    && JSON.stringify(p.proposed?.dedupeKeys) === '["id"]' && p.proposed?.cadence === 'schedule'
    && p.confidence === 'alta',
    JSON.stringify(p.proposed))
})

// Mesma tabela SEM índice nas datas: a regra é a mesma, a cadência não.
cenario(() => {
  const p = decidePlan(
    baseOf(),
    [f('id', 'number'), f('created_at', 'date'), f('updated_at', 'date')],
    keysOf({ pk: ['id'] }),
  )
  check('chave de data sem índice → cai para hora em hora e avisa',
    p.proposed?.cadence === 'hourly' && p.warnings.some((w) => w.includes('NÃO é a primeira coluna')),
    `cadência ${p.proposed?.cadence}`)
})

// Nomes em português, e um "data_atualizacao" que não pode virar "criação".
cenario(() => {
  const p = decidePlan(
    baseOf(),
    [f('codigo', 'number'), f('data_cadastro', 'date'), f('data_atualizacao', 'date')],
    keysOf({ pk: ['codigo'], indexes: [['data_cadastro'], ['data_atualizacao']] }),
  )
  check('nomes em português não trocam criação por edição',
    p.proposed?.incrementalKey === 'data_cadastro' && p.proposed?.incrementalKey2 === 'data_atualizacao',
    JSON.stringify([p.proposed?.incrementalKey, p.proposed?.incrementalKey2]))
})

// Sem identidade: a 2ª chave TEM de ficar de fora, senão duplica a linha — é a
// constraint do banco, e o motor não pode propor o que o banco recusa.
cenario(() => {
  const p = decidePlan(
    baseOf(),
    [f('nome', 'text'), f('created_at', 'date'), f('updated_at', 'date')],
    keysOf({ indexes: [['created_at']] }),
  )
  check('sem identidade → 2ª chave suprimida (o banco a recusaria)',
    p.proposed?.incrementalKey2 === null && p.proposed?.dedupeKeys.length === 0
    && p.warnings.some((w) => w.includes('exige identidade')),
    JSON.stringify(p.proposed))
  check('sem identidade → folga de reconferência fica em zero',
    p.proposed?.watermarkLagMinutes === 0)
})

// Só PK numérica, nenhuma data: pega inserção, não pega edição — e diz isso.
cenario(() => {
  const p = decidePlan(
    baseOf(),
    [f('id', 'number'), f('nome', 'text')],
    keysOf({ pk: ['id'] }),
  )
  check('sem coluna de data → chave numérica, com o aviso de que edição não volta',
    p.proposed?.incrementalKey === 'id' && p.proposed?.incrementalKey2 === null
    && p.warnings.some((w) => w.includes('não pega EDIÇÕES')),
    JSON.stringify(p.proposed))
})

// Nada serve: sem data e sem identificador. Tem de bloquear, não inventar.
cenario(() => {
  const p = decidePlan(
    baseOf(),
    [f('nome', 'text'), f('descricao', 'text')],
    keysOf({}),
  )
  check('sem chave possível → bloqueia em vez de propor', p.proposed === null && !!p.blocker)
})

// Identidade COMPOSTA de índice único, com a PK fora dos campos publicados.
cenario(() => {
  const p = decidePlan(
    baseOf(),
    [f('tenant', 'text'), f('doc', 'text'), f('created_at', 'date')],
    keysOf({
      pk: ['id_interno'],
      uniques: [{ name: 'u_doc', columns: ['tenant', 'doc'] }],
      indexes: [['created_at']],
    }),
  )
  check('PK não publicada → cai para o índice único composto',
    JSON.stringify(p.proposed?.dedupeKeys) === '["tenant","doc"]', JSON.stringify(p.proposed?.dedupeKeys))
})

// Já configurado exatamente assim: não pode aparecer como pendente.
cenario(() => {
  const p = decidePlan(
    baseOf({
      current: {
        mode: 'incremental', incrementalKey: 'created_at', incrementalKey2: 'updated_at',
        dedupeKeys: ['id'], cadence: 'schedule', watermarkLagMinutes: 10,
      },
    }),
    [f('id', 'number'), f('created_at', 'date'), f('updated_at', 'date')],
    keysOf({ pk: ['id'], indexes: [['created_at'], ['updated_at']] }),
  )
  check('conjunto já padronizado é reconhecido como tal', p.alreadyApplied && !p.warnings.length,
    `alreadyApplied=${p.alreadyApplied} avisos=${p.warnings.length}`)
})

// Incremental antigo ganhando identidade: precisa avisar que o total vai cair.
cenario(() => {
  const p = decidePlan(
    baseOf({
      current: {
        mode: 'incremental', incrementalKey: 'created_at', incrementalKey2: null,
        dedupeKeys: [], cadence: 'hourly', watermarkLagMinutes: 0,
      },
    }),
    [f('id', 'number'), f('created_at', 'date'), f('updated_at', 'date')],
    keysOf({ pk: ['id'], indexes: [['created_at'], ['updated_at']] }),
  )
  check('ganhar identidade avisa que o total de linhas vai cair',
    p.warnings.some((w) => w.includes('VAI CAIR')))
})

// View: sem catálogo de índice, a identidade vira palpite e a confiança cai.
cenario(() => {
  const p = decidePlan(
    baseOf(),
    [f('id', 'number'), f('created_at', 'date')],
    keysOf({ isView: true }),
  )
  check('view → identidade por palpite, marcada como tal',
    JSON.stringify(p.proposed?.dedupeKeys) === '["id"]'
    && p.warnings.some((w) => w.includes('PALPITE')) && p.confidence === 'baixa',
    JSON.stringify(p.proposed))
  check('view NÃO ganha cadência de minutos (custo invisível por trás dela)',
    p.proposed?.cadence === 'hourly', `cadência ${p.proposed?.cadence}`)
})

// ── 5. Conjunto que não consegue sincronizar ────────────────────────────
// O caso real que passou despercebido: um conjunto falhava em TODA execução
// havia dias porque um campo apontava para a coluna `regular_price`, que não
// existe mais na fonte. O diagnóstico propunha alegremente uma regra de
// atualização para um conjunto que não roda — parecia saudável na tela.
console.log('\n── conjunto que não consegue sincronizar ──')

cenario(() => {
  const p = decidePlan(
    baseOf({
      drift: { missing: [{ key: 'regular_price', sourceColumn: 'regular_price' }], extra: [], checked: true },
      health: {
        lastSuccessAt: null, lastRunAt: '2026-09-18T13:21:56.000Z',
        lastError: 'column "regular_price" does not exist', failuresSinceSuccess: 13, failing: true,
        pausedReason: null,
      },
    }),
    [f('id', 'number'), f('regular_price', 'number'), f('created_at', 'date'), f('updated_at', 'date')],
    keysOf({ pk: ['id'], indexes: [['created_at'], ['updated_at']] }),
  )
  check('coluna que sumiu da fonte bloqueia, em vez de propor cadência',
    p.proposed === null && !!p.blocker && p.blocker.includes('regular_price'),
    p.blocker ?? JSON.stringify(p.proposed))
})

cenario(() => {
  const p = decidePlan(
    baseOf({
      health: {
        lastSuccessAt: '2026-09-15T03:00:00.000Z', lastRunAt: '2026-09-18T13:00:00.000Z',
        lastError: 'timeout ao consultar a fonte', failuresSinceSuccess: 7, failing: true,
        pausedReason: null,
      },
    }),
    [f('id', 'number'), f('created_at', 'date'), f('updated_at', 'date')],
    keysOf({ pk: ['id'], indexes: [['created_at'], ['updated_at']] }),
  )
  check('falha por outro motivo avisa, mas não impede a proposta',
    !!p.proposed && p.warnings.some((w) => w.includes('FALHANDO') && w.includes('7 execução')),
    p.warnings.join(' | '))
})

cenario(() => {
  const p = decidePlan(
    baseOf({ drift: { missing: [], extra: ['data_cadastro', 'promo_price'], checked: true } }),
    [f('id', 'number'), f('nome', 'text')],
    keysOf({ pk: ['id'] }),
  )
  check('coluna nova na fonte vira aviso, não bloqueio',
    !!p.proposed && p.warnings.some((w) => w.includes('data_cadastro')),
    p.warnings.join(' | '))
})

// ── 6. Chave numérica precisa ser ÚNICA POR LINHA ───────────────────────
// Três conjuntos reais receberam chave que repete. Numa passada keyset isso
// não trava: o cursor avança para o valor repetido e o `>` DESCARTA o resto do
// grupo. Some dado, sem erro. Nome com cara de id não prova unicidade —
// só o catálogo prova.
console.log('\n── chave numérica só serve se for única por linha ──')

cenario(() => {
  // db_matrix_login: PK composta (id_agente, data_login). `id_agente` repete a
  // cada login do mesmo agente.
  const p = decidePlan(
    baseOf(),
    [f('id_agente', 'number'), f('data_login', 'date'), f('duracao', 'number')],
    keysOf({ pk: ['id_agente', 'data_login'] }),
  )
  check('1ª coluna de PK composta NÃO vira chave incremental',
    p.proposed?.incrementalKey !== 'id_agente',
    `propôs ${p.proposed?.incrementalKey ?? 'nada (bloqueou)'}`)
})

cenario(() => {
  // UMovMe - customfield: `cet_id` é chave estrangeira; a PK é `cfd_id`.
  const p = decidePlan(
    baseOf(),
    [f('cet_id', 'number'), f('valor', 'text')],
    keysOf({ pk: ['cfd_id'], indexes: [['cet_id']] }), // cfd_id não publicado
  )
  check('chave estrangeira NÃO vira chave incremental',
    p.proposed?.incrementalKey !== 'cet_id',
    `propôs ${p.proposed?.incrementalKey ?? 'nada (bloqueou)'}`)
})

cenario(() => {
  // Sem data e sem coluna única publicada: bloquear é a resposta certa.
  const p = decidePlan(
    baseOf(),
    [f('id_agente', 'number'), f('id_fila', 'number')],
    keysOf({ pk: ['id_agente', 'id_fila'] }),
  )
  check('sem coluna única por linha, bloqueia em vez de adivinhar',
    p.proposed === null && !!p.blocker && p.blocker.includes('ÚNICA POR LINHA'),
    p.blocker ?? JSON.stringify(p.proposed))
})

cenario(() => {
  // PK de coluna única continua servindo — a correção não pode ter fechado
  // o caminho legítimo.
  const p = decidePlan(
    baseOf(),
    [f('id', 'number'), f('nome', 'text')],
    keysOf({ pk: ['id'] }),
  )
  check('PK de uma coluna só continua servindo de chave',
    p.proposed?.incrementalKey === 'id', JSON.stringify(p.proposed))
})

cenario(() => {
  // O formato de `db_senior_collaborators`: sem coluna de criação, mas COM
  // `updated_at`. A 1ª chave é o id numérico e a 2ª é temporal — e é a folga
  // que impede uma edição com carimbo retroativo de cair atrás do corte.
  const p = decidePlan(
    baseOf(),
    [f('id', 'number'), f('updated_at', 'date'), f('nome', 'text')],
    keysOf({ pk: ['id'], indexes: [['updated_at']] }),
  )
  check('id numérico + updated_at: as duas chaves entram',
    p.proposed?.incrementalKey === 'id' && p.proposed?.incrementalKey2 === 'updated_at',
    JSON.stringify(p.proposed))
  check('com 2ª chave temporal, a folga de reconferência entra mesmo com 1ª chave numérica',
    p.proposed?.watermarkLagMinutes === 10, `folga ${p.proposed?.watermarkLagMinutes}`)
})

cenario(() => {
  // Índice único de uma coluna também prova unicidade, mesmo sem ser PK.
  const p = decidePlan(
    baseOf(),
    [f('numero_nota', 'number'), f('valor', 'number')],
    keysOf({ pk: ['id_interno'], uniques: [{ name: 'u_nota', columns: ['numero_nota'] }] }),
  )
  check('índice único de uma coluna serve de chave',
    p.proposed?.incrementalKey === 'numero_nota', JSON.stringify(p.proposed))
})

console.log(`\n${failures ? `${failures} verificação(ões) falharam.` : 'Tudo certo.'}`)
process.exit(failures ? 1 : 0)
