// ─────────────────────────────────────────────────────────────────────────
// Tradutor do SQL de METADADOS: dialeto Postgres → MariaDB 10.11.
//
// Por que um tradutor, e não reescrever as ~480 consultas: o Data Hub roda em
// Postgres em produção e vai continuar rodando até o dia da virada. Reescrever
// tudo de uma vez obrigaria a trocar de banco no mesmo deploy que troca o
// código — sem volta fácil. Com o tradutor, o MESMO código roda nos dois
// bancos (DATAHUB_DB_DRIVER escolhe), a suíte do comitê passa nos dois, e a
// virada vira uma troca de variável que se desfaz com outra.
//
// O que ele faz é só o MECÂNICO, com o SQL quebrado em tokens (nunca regex
// sobre o texto: literal e identificador entre aspas ficam intactos):
//   $1, $2…            → marcadores que o cliente preenche com escape próprio
//   x::tipo            → CAST(x AS …) ou some (uuid, json, arrays)
//   = any($1) / <> all → IN (lista) / NOT IN (lista), lista vazia tratada
//   $1 = any(coluna)   → JSON_CONTAINS (arrays viram JSON no MariaDB)
//   ilike              → LOWER(a) LIKE LOWER(b) (o banco compara em binário)
//   interval '5 min'   → INTERVAL 5 MINUTE; make_interval(days => x)
//   on conflict        → ON DUPLICATE KEY UPDATE / "do nothing" emulado
//   update … returning → plano em 3 passos (o MariaDB não tem)
//   ordenação de NULL  → igual à do Postgres (o MariaDB inverte)
//   nomes de coluna    → os que o Postgres daria (count, coalesce…)
// e marca o TIPO que o Postgres devolveria (int, json, bool) para o cliente
// converter a linha. O que não é mecânico NÃO é adivinhado: lança erro com o
// nome da construção, e a consulta é reescrita em SQL que roda nos dois.
// ─────────────────────────────────────────────────────────────────────────

// 'dtsoft': parâmetro que vai para coluna DATETIME sem cast explícito — o
// cliente converte só texto ISO com fuso ('…Z', '…-03:00'), que o Postgres
// aceita e o MariaDB recusa. Qualquer outro valor passa como veio.
export type ParamKind = 'value' | 'list' | 'int' | 'datetime' | 'date' | 'json' | 'dtsoft'
/** Marcador de parâmetro: índice (0-based) no array de parâmetros. */
export interface ParamSeg { p: number; kind: ParamKind; neg?: boolean }
/** Lista de chaves primárias do passo 1 do UPDATE … RETURNING. */
export interface IdsSeg { ids: true }
export type Seg = string | ParamSeg | IdsSeg

/** Tipo que o Postgres devolveria numa coluna do resultado. */
export type Hint = 'int' | 'json' | 'bool' | 'text'

export interface UpdateReturningPlan {
  pk: string[]
  /** SELECT pk … WHERE … FOR UPDATE */
  lock: Seg[]
  /** UPDATE … WHERE pk IN <ids> */
  update: Seg[]
  /** SELECT <returning> … WHERE pk IN <ids> */
  select: Seg[]
}

export interface Translated {
  kind: 'plain' | 'update-returning' | 'insert-do-nothing' | 'tx'
  segs: Seg[]
  hints: Record<string, Hint>
  upd?: UpdateReturningPlan
}

export interface TranslateOpts {
  /** Colunas da chave primária da tabela (para UPDATE … RETURNING). */
  pk(table: string): string[] | undefined
  /** true = coluna NOT NULL em toda tabela que a tem (ordenação dispensa a chave de NULL). */
  notNull(column: string): boolean
  /** true = coluna DATETIME em toda tabela que a tem (parâmetro ganha 'dtsoft'). */
  datetimeCol?(column: string): boolean
}

export class UnsupportedSqlError extends Error {
  constructor(what: string, sql: string) {
    super(`[mariadb] construção do Postgres sem tradução: ${what}. Reescreva a consulta em SQL que rode nos dois bancos. SQL: ${sql.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
    this.name = 'UnsupportedSqlError'
  }
}

// ── Tokens ────────────────────────────────────────────────────────────────
type Kind = 'ws' | 'str' | 'estr' | 'qid' | 'par' | 'num' | 'w' | 'op' | 'raw' | 'ids'
interface Tok { k: Kind; v: string; n?: number; pk?: ParamKind; neg?: boolean }

const OPS = ['->>', '#>>', '<=>', '!~*', '::', '->', '#>', '<>', '!=', '<=', '>=', '||', '@>', '<@', '&&', '!~', '~*', '=>']

function tokenize(sql: string): Tok[] {
  const out: Tok[] = []
  const n = sql.length
  let i = 0
  const ws = () => { if (out.length && out[out.length - 1].k !== 'ws') out.push({ k: 'ws', v: ' ' }) }
  while (i < n) {
    const c = sql[i]
    if (/\s/.test(c)) { ws(); i++; continue }
    if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); ws(); i = j < 0 ? n : j; continue }
    if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2)
      if (j < 0) throw new UnsupportedSqlError('comentário /* sem fim', sql)
      ws(); i = j + 2; continue
    }
    if (c === "'") {
      let j = i + 1
      let s = ''
      for (;;) {
        if (j >= n) throw new UnsupportedSqlError('literal sem fim', sql)
        if (sql[j] === "'") { if (sql[j + 1] === "'") { s += "''"; j += 2; continue } break }
        s += sql[j]; j++
      }
      out.push({ k: 'str', v: s }); i = j + 1; continue
    }
    if (c === '"') {
      let j = i + 1
      for (;;) {
        if (j >= n) throw new UnsupportedSqlError('identificador sem fim', sql)
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue } break }
        j++
      }
      out.push({ k: 'qid', v: sql.slice(i, j + 1) }); i = j + 1; continue
    }
    if (c === '$') {
      const m = /^\$(\d+)/.exec(sql.slice(i))
      if (!m) throw new UnsupportedSqlError('$$ (dollar quoting)', sql)
      out.push({ k: 'par', v: m[0], n: Number(m[1]) - 1 }); i += m[0].length; continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(i))!
      out.push({ k: 'num', v: m[0] }); i += m[0].length; continue
    }
    if (/[A-Za-z_À-ɏ]/.test(c)) {
      const m = /^[A-Za-z_À-ɏ][A-Za-z0-9_$À-ɏ]*/.exec(sql.slice(i))!
      // E'…' — literal com escapes de barra (mesma convenção do MariaDB)
      if ((m[0] === 'E' || m[0] === 'e') && sql[i + 1] === "'") {
        let j = i + 2
        let s = ''
        for (;;) {
          if (j >= n) throw new UnsupportedSqlError('literal sem fim', sql)
          if (sql[j] === '\\') { s += sql[j] + (sql[j + 1] ?? ''); j += 2; continue }
          if (sql[j] === "'") { if (sql[j + 1] === "'") { s += "''"; j += 2; continue } break }
          s += sql[j]; j++
        }
        out.push({ k: 'estr', v: s }); i = j + 1; continue
      }
      out.push({ k: 'w', v: m[0] }); i += m[0].length; continue
    }
    const op = OPS.find((o) => sql.startsWith(o, i))
    if (op) { out.push({ k: 'op', v: op }); i += op.length; continue }
    out.push({ k: 'op', v: c }); i++
  }
  while (out.length && out[0].k === 'ws') out.shift()
  while (out.length && out[out.length - 1].k === 'ws') out.pop()
  return out
}

// ── Navegação ─────────────────────────────────────────────────────────────
const lw = (t: Tok | undefined) => (t && t.k === 'w' ? t.v.toLowerCase() : '')
const isW = (t: Tok | undefined, ...ws: string[]) => !!t && t.k === 'w' && ws.includes(t.v.toLowerCase())
const isOp = (t: Tok | undefined, ...ops: string[]) => !!t && t.k === 'op' && ops.includes(t.v)

function nx(a: Tok[], i: number): number {
  for (let j = i + 1; j < a.length; j++) if (a[j].k !== 'ws') return j
  return -1
}
function pv(a: Tok[], i: number): number {
  for (let j = i - 1; j >= 0; j--) if (a[j].k !== 'ws') return j
  return -1
}
function closeOf(a: Tok[], i: number): number {
  let d = 0
  for (let j = i; j < a.length; j++) {
    if (isOp(a[j], '(')) d++
    else if (isOp(a[j], ')')) { d--; if (d === 0) return j }
  }
  throw new Error('parênteses desbalanceados')
}
function openOf(a: Tok[], i: number): number {
  let d = 0
  for (let j = i; j >= 0; j--) {
    if (isOp(a[j], ')')) d++
    else if (isOp(a[j], '(')) { d--; if (d === 0) return j }
  }
  throw new Error('parênteses desbalanceados')
}
/** `case` que fecha com o `end` em i. */
function caseOf(a: Tok[], i: number): number {
  let d = 0
  for (let j = i; j >= 0; j--) {
    if (isW(a[j], 'end')) d++
    else if (isW(a[j], 'case')) { d--; if (d === 0) return j }
  }
  throw new Error('case sem end')
}
function endOf(a: Tok[], i: number): number {
  let d = 0
  for (let j = i; j < a.length; j++) {
    if (isW(a[j], 'case')) d++
    else if (isW(a[j], 'end')) { d--; if (d === 0) return j }
  }
  throw new Error('case sem end')
}

// Palavras que antecedem "(" sem ser chamada de função.
const NOT_FUNC = new Set([
  'in', 'and', 'or', 'not', 'select', 'where', 'on', 'as', 'exists', 'then', 'else', 'when',
  'by', 'values', 'from', 'join', 'case', 'is', 'like', 'ilike', 'between', 'set', 'returning',
  'any', 'all', 'distinct', 'having', 'using', 'with', 'over', 'filter', 'into', 'limit', 'offset',
  'union', 'except', 'intersect', 'conflict', 'do', 'update', 'lateral', 'return',
])

/** Início do operando que TERMINA logo antes do índice i. */
function operandStart(a: Tok[], i: number, sql: string): number {
  const j = pv(a, i)
  if (j < 0) throw new UnsupportedSqlError('operando ausente', sql)
  const t = a[j]
  const dotted = (s: number) => {
    let start = s
    for (;;) {
      const d = pv(a, start)
      const b = d >= 0 ? pv(a, d) : -1
      if (d >= 0 && isOp(a[d], '.') && b >= 0 && (a[b].k === 'w' || a[b].k === 'qid')) start = b
      else return start
    }
  }
  if (isOp(t, ')')) {
    const k = openOf(a, j)
    const f = pv(a, k)
    if (f >= 0 && a[f].k === 'w' && !NOT_FUNC.has(lw(a[f]))) return dotted(f)
    return k
  }
  if (isW(t, 'end')) return caseOf(a, j)
  if (t.k === 'w' || t.k === 'qid') return dotted(j)
  if (['par', 'num', 'str', 'estr', 'raw'].includes(t.k)) return j
  throw new UnsupportedSqlError(`operando antes de "${a[i]?.v}"`, sql)
}

/** Fim do operando que COMEÇA no índice i. */
function operandEnd(a: Tok[], i: number, sql: string): number {
  const t = a[i]
  if (!t) throw new UnsupportedSqlError('operando ausente', sql)
  if (isOp(t, '(')) return closeOf(a, i)
  if (isOp(t, '-', '+') || isW(t, 'not')) return operandEnd(a, nx(a, i), sql)
  if (isW(t, 'case')) return endOf(a, i)
  if (t.k === 'w' || t.k === 'qid') {
    let j = i
    for (;;) {
      const d = nx(a, j)
      const e = d >= 0 ? nx(a, d) : -1
      if (d >= 0 && isOp(a[d], '.') && e >= 0 && (a[e].k === 'w' || a[e].k === 'qid' || isOp(a[e], '*'))) j = e
      else break
    }
    const p = nx(a, j)
    if (t.k === 'w' && p >= 0 && isOp(a[p], '(') && !NOT_FUNC.has(lw(t))) j = closeOf(a, p)
    return j
  }
  if (['par', 'num', 'str', 'estr', 'raw'].includes(t.k)) return i
  throw new UnsupportedSqlError(`operando em "${t.v}"`, sql)
}

const raw = (v: string): Tok => ({ k: 'raw', v })
const W = (v: string): Tok => ({ k: 'w', v })
const SP: Tok = { k: 'ws', v: ' ' }
const splice = (a: Tok[], s: number, e: number, mid: Tok[]) => [...a.slice(0, s), ...mid, ...a.slice(e + 1)]
const trimWs = (a: Tok[]) => {
  let s = 0
  let e = a.length
  while (s < e && a[s].k === 'ws') s++
  while (e > s && a[e - 1].k === 'ws') e--
  return a.slice(s, e)
}

/** Divide os tokens [s, e) nas vírgulas de profundidade 0 (fora de parênteses e de case…end). */
function splitTop(a: Tok[], s: number, e: number): Array<[number, number]> {
  const parts: Array<[number, number]> = []
  let d = 0
  let start = s
  for (let j = s; j < e; j++) {
    if (isOp(a[j], '(') || isW(a[j], 'case')) d++
    else if (isOp(a[j], ')') || isW(a[j], 'end')) d--
    else if (d === 0 && isOp(a[j], ',')) { parts.push([start, j]); start = j + 1 }
  }
  parts.push([start, e])
  return parts
}

/** Índice do primeiro token em [s, e) de profundidade 0 que satisfaz f. */
function findTop(a: Tok[], s: number, e: number, f: (t: Tok, j: number) => boolean): number {
  let d = 0
  for (let j = s; j < e; j++) {
    if (isOp(a[j], '(')) d++
    else if (isOp(a[j], ')')) { d--; if (d < 0) return -1 }
    else if (d === 0 && f(a[j], j)) return j
  }
  return -1
}

// ── Tipos ─────────────────────────────────────────────────────────────────
interface CastTarget { sql: string | null; param?: ParamKind; hint?: Hint }
function castTarget(type: string, sql: string): CastTarget {
  const t = type.toLowerCase().replace(/\s+/g, ' ').replace(/\(.*\)/, '').trim()
  if (t.endsWith('[]')) return { sql: null, param: 'list' }
  switch (t) {
    case 'int': case 'integer': case 'int4': case 'int2': case 'smallint':
      return { sql: 'SIGNED', param: 'int', hint: 'int' }
    case 'bigint': case 'int8':
      return { sql: 'SIGNED', param: 'int' }
    case 'numeric': case 'decimal':
      return { sql: 'DECIMAL(38,10)' }
    case 'float': case 'float8': case 'double precision': case 'real': case 'float4':
      return { sql: 'DOUBLE' }
    case 'text': case 'varchar': case 'character varying': case 'char': case 'name':
      return { sql: 'CHAR' }
    case 'date':
      return { sql: 'DATE', param: 'date' }
    case 'timestamptz': case 'timestamp': case 'timestamp with time zone': case 'timestamp without time zone':
      return { sql: 'DATETIME(6)', param: 'datetime' }
    case 'uuid': case 'vector':
      return { sql: null }
    case 'json': case 'jsonb':
      return { sql: null, param: 'json', hint: 'json' }
    case 'boolean': case 'bool':
      return { sql: null, hint: 'bool' }
  }
  throw new UnsupportedSqlError(`cast para ${type}`, sql)
}

/** Lê o tipo depois de "::" (a partir de i) e devolve [texto do tipo, último índice]. */
function readType(a: Tok[], i: number, sql: string): [string, number] {
  let j = nx(a, i)
  if (j < 0 || a[j].k !== 'w') throw new UnsupportedSqlError('cast sem tipo', sql)
  let type = a[j].v
  const more = (w: string) => { const k = nx(a, j); if (k >= 0 && isW(a[k], w)) { type += ' ' + a[k].v; j = k; return true } return false }
  if (isW(a[j], 'double')) more('precision')
  if (isW(a[j], 'character')) more('varying')
  if (isW(a[j], 'timestamp', 'time')) {
    if (more('with') || more('without')) { more('time'); more('zone') }
  }
  let k = nx(a, j)
  if (k >= 0 && isOp(a[k], '(')) { const c = closeOf(a, k); type += a.slice(k, c + 1).map((t) => t.v).join(''); j = c; k = nx(a, j) }
  if (k >= 0 && isOp(a[k], '[')) { const c = nx(a, k); if (c >= 0 && isOp(a[c], ']')) { type += '[]'; j = c } }
  return [type, j]
}

// ── Nomes e tipos das colunas do resultado ───────────────────────────────
const JSON_FUNCS = new Set(['json_build_object', 'jsonb_build_object', 'json_agg', 'jsonb_agg', 'json_object', 'json_arrayagg', 'json_array'])
const BOOL_WORDS = new Set(['is', 'exists', 'not', 'in', 'like', 'ilike', 'between', 'and', 'or'])
const KEYWORDS_END = new Set(['from', 'where', 'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'into', 'for', 'window', 'returning', 'on'])

interface ItemInfo { name: string | null; hint?: Hint; addAlias?: string; lowerAlias?: number }

/** Nome que o Postgres dá à coluna e o tipo que devolve, para um item [s, e). */
function describeItem(a: Tok[], s: number, e: number): ItemInfo {
  const toks: number[] = []
  for (let j = s; j < e; j++) if (a[j].k !== 'ws') toks.push(j)
  if (!toks.length) return { name: null }
  // alias explícito
  const last = toks[toks.length - 1]
  const beforeLast = toks.length >= 2 ? toks[toks.length - 2] : -1
  let exprEnd = toks.length
  let name: string | null = null
  let lowerAlias: number | undefined
  if (beforeLast >= 0 && isW(a[beforeLast], 'as') && (a[last].k === 'w' || a[last].k === 'qid')) {
    exprEnd = toks.length - 2
    name = a[last].k === 'qid' ? a[last].v.slice(1, -1) : a[last].v.toLowerCase()
    if (a[last].k === 'w') lowerAlias = last
  } else if (toks.length >= 2 && a[last].k === 'w' && !KEYWORDS_END.has(lw(a[last])) && !isW(a[last], 'end')
    && (isOp(a[beforeLast], ')') || a[beforeLast].k === 'w' || a[beforeLast].k === 'qid' || a[beforeLast].k === 'str' || a[beforeLast].k === 'num')
    && !isOp(a[pv(a, last)], '.')) {
    // alias implícito: "count(*) n"
    exprEnd = toks.length - 1
    name = a[last].v.toLowerCase()
    lowerAlias = last
  }
  const ex = toks.slice(0, exprEnd)
  const hint = hintOf(a, ex)
  if (name) return { name, hint, lowerAlias }
  // sem alias: o nome que o Postgres daria
  const first = a[ex[0]]
  if (ex.length === 1 && (first.k === 'w' || first.k === 'qid')) return { name: first.k === 'qid' ? first.v.slice(1, -1) : first.v.toLowerCase(), hint }
  // a.b ou a.b.c
  if (ex.every((j, idx) => (idx % 2 === 1 ? isOp(a[j], '.') : a[j].k === 'w' || a[j].k === 'qid' || isOp(a[j], '*')))) {
    const lastTok = a[ex[ex.length - 1]]
    if (isOp(lastTok, '*')) return { name: null }
    return { name: lastTok.k === 'qid' ? lastTok.v.slice(1, -1) : lastTok.v.toLowerCase(), hint }
  }
  // expressão: nome da função mais de fora (o Postgres faz assim)
  let pgName = '?column?'
  if (first.k === 'w' && ex.length >= 2 && isOp(a[ex[1]], '(')) pgName = first.v.toLowerCase()
  else if (isW(first, 'case')) pgName = 'case'
  else if (first.k === 'w' || first.k === 'qid') {
    // coluna com cast: d.col::text → "col"
    let k = 0
    while (k + 2 < ex.length && isOp(a[ex[k + 1]], '.')) k += 2
    if (k + 1 < ex.length && isOp(a[ex[k + 1]], '::')) pgName = a[ex[k]].k === 'qid' ? a[ex[k]].v.slice(1, -1) : a[ex[k]].v.toLowerCase()
  } else if (isOp(first, '(') && closeOf(a, ex[0]) === ex[ex.length - 1]) {
    // subconsulta escalar: o nome é o da coluna dela
    const inner = nx(a, ex[0])
    if (inner >= 0 && isW(a[inner], 'select')) {
      const close = ex[ex.length - 1]
      const fromIdx = findTop(a, inner + 1, close, (t) => isW(t, 'from'))
      const items = splitTop(a, inner + 1, fromIdx < 0 ? close : fromIdx)
      const info = describeItem(a, items[0][0], items[0][1])
      if (info.name) pgName = info.name
    }
  }
  if (pgName.startsWith('json_') || pgName.startsWith('jsonb_')) {
    // a função será renomeada; o nome do Postgres é o original
  }
  return { name: pgName, hint, addAlias: pgName }
}

function hintOf(a: Tok[], ex: number[]): Hint | undefined {
  if (!ex.length) return undefined
  // um cast que cobre o item INTEIRO decide: (expr)::int, count(*)::int
  for (let k = ex.length - 2; k >= 1; k--) {
    if (!isOp(a[ex[k]], '::') || depthAt(a, ex, k) !== 0) continue
    try {
      const [type, te] = readType(a, ex[k], '')
      if (te !== ex[ex.length - 1] || operandStart(a, ex[k], '') !== ex[0]) break
      return castTarget(type, '').hint
    } catch { return undefined }
  }
  const first = a[ex[0]]
  // subconsulta escalar ou parênteses em volta: olha dentro
  if (isOp(first, '(') && closeOf(a, ex[0]) === ex[ex.length - 1]) {
    const inner = nx(a, ex[0])
    if (inner >= 0 && isW(a[inner], 'select')) {
      const close = ex[ex.length - 1]
      const fromIdx = findTop(a, inner + 1, close, (t) => isW(t, 'from'))
      const items = splitTop(a, inner + 1, fromIdx < 0 ? close : fromIdx)
      return describeItem(a, items[0][0], items[0][1]).hint
    }
    const innerToks: number[] = []
    for (let j = ex[0] + 1; j < ex[ex.length - 1]; j++) if (a[j].k !== 'ws') innerToks.push(j)
    return hintOf(a, innerToks)
  }
  const fn = first.k === 'w' && ex.length >= 2 && isOp(a[ex[1]], '(') ? lw(first) : ''
  if (fn && closeOf(a, ex[1]) === ex[ex.length - 1]) {
    if (JSON_FUNCS.has(fn) || fn === 'to_json') return 'json'
    if (fn === 'bool_or' || fn === 'bool_and' || fn === 'exists') return 'bool'
    if (fn === 'count') return 'text'
    if (fn === 'coalesce') {
      const args = splitTop(a, ex[1] + 1, ex[ex.length - 1])
      for (const [s, e] of args) {
        const t = trimWs(a.slice(s, e))
        if (t.length === 1 && isW(t[0], 'true', 'false')) return 'bool'
        const f = t[0] && t[0].k === 'w' ? lw(t[0]) : ''
        if (f === 'bool_or' || f === 'bool_and') return 'bool'
        if (JSON_FUNCS.has(f)) return 'json'
        if (t.length === 1 && t[0].k === 'str' && /^\s*[[{]/.test(t[0].v)) continue
      }
      // coalesce((select json_agg …), '[]')
      for (const [s, e] of args) {
        const idx: number[] = []
        for (let j = s; j < e; j++) if (a[j].k !== 'ws') idx.push(j)
        const h = idx.length ? hintOf(a, idx) : undefined
        if (h === 'json' || h === 'bool') return h
      }
      return undefined
    }
    return undefined
  }
  if (isW(first, 'case') && endOf(a, ex[0]) === ex[ex.length - 1]) {
    // case … then true else false end
    let allBool = true
    let any = false
    let d = 0
    for (let j = ex[0] + 1; j < ex[ex.length - 1]; j++) {
      if (isW(a[j], 'case') || isOp(a[j], '(')) d++
      else if (isW(a[j], 'end') || isOp(a[j], ')')) d--
      else if (d === 0 && isW(a[j], 'then', 'else')) {
        const v = nx(a, j)
        any = true
        const after = nx(a, v)
        if (!(isW(a[v], 'true', 'false') && (isW(a[after], 'when', 'else', 'end')))) allBool = false
      }
    }
    return any && allBool ? 'bool' : undefined
  }
  // x->'a' devolve JSON (objeto no driver do Postgres); x->>'a' devolve texto
  {
    let d = 0
    let lastJson: string | null = null
    for (const j of ex) {
      const t = a[j]
      if (isOp(t, '(') || isW(t, 'case')) d++
      else if (isOp(t, ')') || isW(t, 'end')) d--
      else if (d === 0 && isOp(t, '->', '->>')) lastJson = t.v
    }
    if (lastJson === '->') return 'json'
    if (lastJson === '->>') return undefined
  }
  // expressão booleana no nível de fora
  let d = 0
  for (const j of ex) {
    const t = a[j]
    if (isOp(t, '(') || isW(t, 'case')) d++
    else if (isOp(t, ')') || isW(t, 'end')) d--
    else if (d === 0) {
      if (isOp(t, '=', '<>', '!=', '<', '>', '<=', '>=')) return 'bool'
      if (t.k === 'w' && BOOL_WORDS.has(lw(t))) return 'bool'
    }
  }
  return undefined
}

function depthAt(a: Tok[], ex: number[], k: number): number {
  let d = 0
  for (let q = 0; q < k; q++) {
    const t = a[ex[q]]
    if (isOp(t, '(') || isW(t, 'case')) d++
    else if (isOp(t, ')') || isW(t, 'end')) d--
  }
  return d
}

/** Primeiro "select" de profundidade 0 que produz o resultado (pula as CTEs). */
function resultSelect(a: Tok[]): number {
  return findTop(a, 0, a.length, (t) => isW(t, 'select'))
}

/** Itens [s, e) da lista do select que começa em sel (ou do returning). */
function listItems(a: Tok[], sel: number): Array<[number, number]> {
  let s = sel + 1
  const d1 = nx(a, sel)
  if (isW(a[d1], 'distinct')) s = d1 + 1
  const end = findTop(a, s, a.length, (t) => (t.k === 'w' && KEYWORDS_END.has(lw(t)) && !isW(t, 'on')) || isOp(t, ';'))
  return splitTop(a, s, end < 0 ? a.length : end)
}

function applyResultNames(a: Tok[], start: number): { a: Tok[]; hints: Record<string, Hint> } {
  const hints: Record<string, Hint> = {}
  const items = listItems(a, start)
  // de trás para frente: inserir não desloca os itens anteriores
  let out = a
  for (let k = items.length - 1; k >= 0; k--) {
    const [s, e] = items[k]
    const info = describeItem(out, s, e)
    if (info.name && info.hint) hints[info.name] = info.hint
    if (info.lowerAlias !== undefined) {
      out = [...out]
      out[info.lowerAlias] = { k: 'qid', v: `"${info.name}"` }
    } else if (info.addAlias) {
      let last = e - 1
      while (last > s && out[last].k === 'ws') last--
      out = [...out.slice(0, last + 1), SP, W('AS'), SP, { k: 'qid', v: `"${info.addAlias.replace(/"/g, '""')}"` }, ...out.slice(last + 1)]
    }
  }
  return { a: out, hints }
}

// ── Passes ────────────────────────────────────────────────────────────────
// <=> é distância de cosseno no pgvector e igualdade "null-safe" no MariaDB:
// passaria sem erro e ordenaria errado. Recusar é o único jeito seguro.
const UNSUPPORTED_OPS = new Set(['#>', '#>>', '@>', '<@', '&&', '~', '~*', '!~', '!~*', '?', '<=>'])
const UNSUPPORTED_FUNCS = new Set([
  'array_agg', 'to_jsonb', 'row_to_json', 'date_trunc', 'to_char', 'extract', 'age', 'split_part',
  'unnest', 'generate_series', 'percentile_cont', 'percentile_disc', 'jsonb_set', 'array_length',
  'array_append', 'array_remove', 'array_position', 'cardinality', 'string_to_array', 'regexp_split_to_table',
  'jsonb_each', 'jsonb_object_keys', 'jsonb_typeof', 'json_typeof', 'pg_sleep', 'set_config', 'current_setting',
])

function rejectUnsupported(a: Tok[], sql: string): void {
  for (let j = 0; j < a.length; j++) {
    const t = a[j]
    if (t.k === 'op' && UNSUPPORTED_OPS.has(t.v)) throw new UnsupportedSqlError(`operador ${t.v}`, sql)
    if (t.k !== 'w') continue
    const v = lw(t)
    const n1 = nx(a, j)
    if (UNSUPPORTED_FUNCS.has(v) && n1 >= 0 && isOp(a[n1], '(')) throw new UnsupportedSqlError(`função ${v}()`, sql)
    if (v === 'lateral') throw new UnsupportedSqlError('join lateral', sql)
    if (v === 'distinct' && isW(a[n1], 'on')) throw new UnsupportedSqlError('distinct on', sql)
    if (v === 'similar' && isW(a[n1], 'to')) throw new UnsupportedSqlError('similar to', sql)
    if (v === 'array' && n1 >= 0 && isOp(a[n1], '[')) throw new UnsupportedSqlError('array[…]', sql)
    if (v === 'at' && isW(a[n1], 'time')) throw new UnsupportedSqlError('at time zone', sql)
    if (v === 'skip' && isW(a[n1], 'locked')) throw new UnsupportedSqlError('skip locked', sql)
    if (v === 'is' && (isW(a[n1], 'distinct') || (isW(a[n1], 'not') && isW(a[nx(a, n1)], 'distinct')))) throw new UnsupportedSqlError('is distinct from', sql)
  }
}

/**
 * x->'a'->>'b' → JSON_EXTRACT / JSON_UNQUOTE com o caminho $."a"."b".
 * O ->> devolve NULL para null do JSON (como no Postgres), não o texto "null".
 */
function passJsonPaths(a: Tok[], sql: string): Tok[] {
  for (;;) {
    const i = a.findIndex((t) => isOp(t, '->', '->>'))
    if (i < 0) return a
    const s = operandStart(a, i, sql)
    let j = i
    let last = i
    let text = false
    let path = '$'
    while (j >= 0) {
      if (text) throw new UnsupportedSqlError('->> seguido de ->', sql)
      const k = nx(a, j)
      const key = a[k]
      if (key?.k === 'str') path += `."${key.v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      else if (key?.k === 'num') path += `[${key.v}]`
      else throw new UnsupportedSqlError('-> com chave que não é literal', sql)
      text = a[j].v === '->>'
      last = k
      const n2 = nx(a, k)
      j = n2 >= 0 && isOp(a[n2], '->', '->>') ? n2 : -1
    }
    const operand = trimWs(a.slice(s, i))
    const extract = () => [W('JSON_EXTRACT'), raw('('), ...operand, raw(`, '${path}')`)]
    const out = text
      ? [raw('(CASE WHEN '), W('JSON_TYPE'), raw('('), ...extract(), raw(") = 'NULL' THEN NULL ELSE "), W('JSON_UNQUOTE'), raw('('), ...extract(), raw(') END)')]
      : extract()
    a = splice(a, s, last, out)
  }
}

/**
 * Parâmetro que vai para uma coluna de data/hora (col = $1, col > $1, ou a
 * posição dele num INSERT) ganha 'dtsoft'. Feito antes de qualquer reescrita,
 * no SQL ainda em Postgres; só marca, não muda token.
 */
function inferDatetimeParams(a: Tok[], kinds: Map<number, ParamKind>, opts: TranslateOpts): void {
  const isDt = opts.datetimeCol
  if (!isDt) return
  const colName = (t: Tok | undefined) => (!t ? null : t.k === 'w' ? lw(t) : t.k === 'qid' ? t.v.slice(1, -1) : null)
  const mark = (n: number | undefined, col: string | null) => {
    if (n !== undefined && col && isDt(col) && !kinds.has(n)) kinds.set(n, 'dtsoft')
  }
  const CMP = ['=', '<>', '!=', '<', '>', '<=', '>=']
  for (let j = 0; j < a.length; j++) {
    if (a[j].k !== 'par') continue
    const p = pv(a, j)
    if (p >= 0 && isOp(a[p], ...CMP)) mark(a[j].n, colName(a[pv(a, p)]))
    const q = nx(a, j)
    if (q >= 0 && isOp(a[q], ...CMP)) {
      let c = nx(a, q)
      while (c >= 0 && (a[c].k === 'w' || a[c].k === 'qid') && isOp(a[nx(a, c)], '.')) c = nx(a, nx(a, c))
      mark(a[j].n, colName(a[c]))
    }
  }
  // insert into t (c1, c2…) values ($1, $2…) | select x, $2…
  const ins = a.findIndex((t) => isW(t, 'insert'))
  if (ins < 0) return
  const open = a.findIndex((t, j) => j > ins && isOp(t, '('))
  if (open < 0) return
  const close = closeOf(a, open)
  const cols = splitTop(a, open + 1, close).map(([s, e]) => colName(trimWs(a.slice(s, e))[0]))
  const after = nx(a, close)
  const tuple = (s: number, e: number) => splitTop(a, s, e).forEach(([x, y], i) => {
    const it = trimWs(a.slice(x, y))
    if (it.length === 1 && it[0].k === 'par') mark(it[0].n, cols[i] ?? null)
  })
  if (isW(a[after], 'values')) {
    let k = nx(a, after)
    while (k >= 0 && isOp(a[k], '(')) {
      const c = closeOf(a, k)
      tuple(k + 1, c)
      const comma = nx(a, c)
      k = comma >= 0 && isOp(a[comma], ',') ? nx(a, comma) : -1
    }
  } else if (isW(a[after], 'select')) {
    const end = findTop(a, after + 1, a.length, (t) => isW(t, 'from', 'where', 'on', 'returning'))
    tuple(after + 1, end < 0 ? a.length : end)
  }
}

function passCasts(a: Tok[], sql: string, kinds: Map<number, ParamKind>): Tok[] {
  for (;;) {
    const i = a.findIndex((t) => isOp(t, '::'))
    if (i < 0) return a
    const s = operandStart(a, i, sql)
    const [type, te] = readType(a, i, sql)
    const tgt = castTarget(type, sql)
    const operand = trimWs(a.slice(s, i))
    if (operand.length === 1 && operand[0].k === 'par' && tgt.param) kinds.set(operand[0].n!, tgt.param)
    const mid = tgt.sql === null || (operand.length === 1 && operand[0].k === 'par' && tgt.param && tgt.param !== 'datetime' && tgt.param !== 'date')
      ? operand
      : [W('CAST'), raw('('), ...operand, SP, W('AS'), SP, raw(tgt.sql), raw(')')]
    a = splice(a, s, te, mid)
  }
}

/** = any($1) → IN (lista); <> all($1) → NOT IN (lista); $1 = any(coluna) → JSON_CONTAINS. */
function passAnyAll(a: Tok[], sql: string, kinds: Map<number, ParamKind>): Tok[] {
  for (;;) {
    const i = a.findIndex((t, j) => isW(t, 'any', 'all') && isOp(a[nx(a, j)], '('))
    if (i < 0) return a
    const op = pv(a, i)
    const isAny = isW(a[i], 'any')
    if (!(isAny ? isOp(a[op], '=') : isOp(a[op], '<>', '!='))) throw new UnsupportedSqlError(`${a[op]?.v} ${a[i].v}(…)`, sql)
    const open = nx(a, i)
    const close = closeOf(a, open)
    const inner = trimWs(a.slice(open + 1, close))
    if (inner.length === 1 && inner[0].k === 'par') {
      kinds.set(inner[0].n!, 'list')
      const marker: Tok = { k: 'par', v: inner[0].v, n: inner[0].n, pk: 'list', neg: !isAny }
      a = splice(a, op, close, [W(isAny ? 'IN' : 'NOT IN'), SP, marker])
      continue
    }
    // valor = any(coluna_array): arrays são JSON no MariaDB
    const ls = operandStart(a, op, sql)
    const lhs = trimWs(a.slice(ls, op))
    const call = [W('JSON_CONTAINS'), raw('('), ...inner, raw(', '), W('JSON_QUOTE'), raw('('), ...lhs, raw('))')]
    a = splice(a, ls, close, isAny ? call : [W('NOT'), SP, ...call])
  }
}

function passIlike(a: Tok[], sql: string): Tok[] {
  for (;;) {
    const i = a.findIndex((t) => isW(t, 'ilike'))
    if (i < 0) return a
    const notIdx = pv(a, i)
    const hasNot = isW(a[notIdx], 'not')
    const opStart = hasNot ? notIdx : i
    const ls = operandStart(a, opStart, sql)
    const rs = nx(a, i)
    let re = operandEnd(a, rs, sql)
    for (;;) {
      const c = nx(a, re)
      if (c >= 0 && isOp(a[c], '||')) re = operandEnd(a, nx(a, c), sql)
      else break
    }
    const lhs = trimWs(a.slice(ls, opStart))
    const rhs = trimWs(a.slice(rs, re + 1))
    a = splice(a, ls, re, [W('LOWER'), raw('('), ...lhs, raw(')'), SP, W(hasNot ? 'NOT LIKE' : 'LIKE'), SP, W('LOWER'), raw('('), ...rhs, raw(')')])
  }
}

const UNITS: Record<string, string> = {
  second: 'SECOND', seconds: 'SECOND', sec: 'SECOND', secs: 'SECOND', s: 'SECOND',
  minute: 'MINUTE', minutes: 'MINUTE', min: 'MINUTE', mins: 'MINUTE', m: 'MINUTE',
  hour: 'HOUR', hours: 'HOUR', h: 'HOUR',
  day: 'DAY', days: 'DAY', d: 'DAY',
  week: 'WEEK', weeks: 'WEEK',
  month: 'MONTH', months: 'MONTH', mon: 'MONTH',
  year: 'YEAR', years: 'YEAR',
}

function passIntervals(a: Tok[], sql: string): Tok[] {
  // make_interval(days => x)
  for (;;) {
    const i = a.findIndex((t, j) => isW(t, 'make_interval') && isOp(a[nx(a, j)], '('))
    if (i < 0) break
    const open = nx(a, i)
    const close = closeOf(a, open)
    const u = nx(a, open)
    const arrow = nx(a, u)
    const unit = UNITS[lw(a[u])]
    if (!unit || !isOp(a[arrow], '=>')) throw new UnsupportedSqlError('make_interval com mais de uma unidade', sql)
    const val = trimWs(a.slice(arrow + 1, close))
    a = splice(a, i, close, [W('INTERVAL'), SP, raw('('), ...val, raw(')'), SP, W(unit)])
  }
  for (;;) {
    const i = a.findIndex((t, j) => isW(t, 'interval') && a[nx(a, j)]?.k === 'str')
    if (i < 0) return a
    const lit = nx(a, i)
    const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(a[lit].v)
    const unit = m ? UNITS[m[2].toLowerCase()] : undefined
    if (!m || !unit) throw new UnsupportedSqlError(`interval '${a[lit].v}'`, sql)
    // x * interval '1 day' → INTERVAL (x) DAY
    const mul = pv(a, i)
    if (mul >= 0 && isOp(a[mul], '*') && Number(m[1]) === 1) {
      const ls = operandStart(a, mul, sql)
      const lhs = trimWs(a.slice(ls, mul))
      a = splice(a, ls, lit, [W('INTERVAL'), SP, raw('('), ...lhs, raw(')'), SP, W(unit)])
      continue
    }
    a = splice(a, i, lit, [W('INTERVAL'), SP, raw(m[1]), SP, W(unit)])
  }
}

const RENAMES: Record<string, string> = {
  json_build_object: 'JSON_OBJECT', jsonb_build_object: 'JSON_OBJECT',
  json_agg: 'JSON_ARRAYAGG', jsonb_agg: 'JSON_ARRAYAGG',
  jsonb_array_length: 'JSON_LENGTH', json_array_length: 'JSON_LENGTH',
  gen_random_uuid: 'UUID', current_database: 'DATABASE', current_schema: 'DATABASE',
  random: 'RAND', length: 'CHAR_LENGTH', bool_or: 'MAX', bool_and: 'MIN',
}

function passFunctions(a: Tok[], sql: string): Tok[] {
  let out = [...a]
  for (let j = 0; j < out.length; j++) {
    const t = out[j]
    if (t.k !== 'w') continue
    const v = lw(t)
    const n1 = nx(out, j)
    const call = n1 >= 0 && isOp(out[n1], '(')
    if (call && RENAMES[v]) out[j] = W(RENAMES[v])
    else if (call && v === 'now') {
      const c = nx(out, n1)
      if (isOp(out[c], ')')) out = splice(out, j, c, [W('NOW'), raw('(6)')])
    } else if (!call && v === 'current_timestamp') out[j] = raw('CURRENT_TIMESTAMP(6)')
  }
  // string_agg(x, sep [order by …]) → GROUP_CONCAT(x [ORDER BY …] SEPARATOR sep)
  for (;;) {
    const i = out.findIndex((t, j) => isW(t, 'string_agg') && isOp(out[nx(out, j)], '('))
    if (i < 0) break
    const open = nx(out, i)
    const close = closeOf(out, open)
    const args = splitTop(out, open + 1, close)
    if (args.length !== 2) throw new UnsupportedSqlError('string_agg com argumentos inesperados', sql)
    const x = trimWs(out.slice(args[0][0], args[0][1]))
    const rest = out.slice(args[1][0], args[1][1])
    const ob = findTop(rest, 0, rest.length, (t) => isW(t, 'order'))
    const sep = trimWs(ob < 0 ? rest : rest.slice(0, ob))
    const order = ob < 0 ? [] : [SP, ...trimWs(rest.slice(ob))]
    out = splice(out, i, close, [W('GROUP_CONCAT'), raw('('), ...x, ...order, SP, W('SEPARATOR'), SP, ...sep, raw(')')])
  }
  // agg(x) filter (where c) → agg(CASE WHEN c THEN x END)
  for (;;) {
    const i = out.findIndex((t, j) => isW(t, 'filter') && isOp(out[nx(out, j)], '(') && isW(out[nx(out, nx(out, j))], 'where'))
    if (i < 0) break
    const aggClose = pv(out, i)
    if (!isOp(out[aggClose], ')')) throw new UnsupportedSqlError('filter sem agregação', sql)
    const aggOpen = openOf(out, aggClose)
    const fOpen = nx(out, i)
    const fClose = closeOf(out, fOpen)
    const cond = trimWs(out.slice(nx(out, fOpen) + 1, fClose))
    const arg = trimWs(out.slice(aggOpen + 1, aggClose))
    const val = arg.length === 1 && isOp(arg[0], '*') ? [raw('1')] : arg
    out = splice(out, aggOpen, fClose, [raw('('), W('CASE WHEN'), SP, ...cond, SP, W('THEN'), SP, ...val, SP, W('END'), raw(')')])
  }
  return out
}

/** ON CONFLICT … DO UPDATE SET … → ON DUPLICATE KEY UPDATE; DO NOTHING → sinalizado. */
function passConflict(a: Tok[], sql: string): { a: Tok[]; doNothing: boolean } {
  const i = a.findIndex((t, j) => isW(t, 'on') && isW(a[nx(a, j)], 'conflict'))
  if (i < 0) return { a, doNothing: false }
  const doIdx = findTop(a, i, a.length, (t) => isW(t, 'do'))
  if (doIdx < 0) throw new UnsupportedSqlError('on conflict sem do', sql)
  const act = nx(a, doIdx)
  const retIdx = findTop(a, act, a.length, (t) => isW(t, 'returning'))
  const end = retIdx < 0 ? a.length : retIdx
  if (isW(a[act], 'nothing')) {
    return { a: [...a.slice(0, pv(a, i) + 1), ...(retIdx < 0 ? [] : [SP, ...a.slice(retIdx)])], doNothing: true }
  }
  if (!isW(a[act], 'update') || !isW(a[nx(a, act)], 'set')) throw new UnsupportedSqlError('on conflict com ação desconhecida', sql)
  const setStart = nx(a, nx(a, act)) // depois de "set"
  if (findTop(a, setStart, end, (t) => isW(t, 'where')) >= 0) throw new UnsupportedSqlError('on conflict do update … where', sql)
  let body = a.slice(setStart, end)
  // excluded.col → VALUES(col)
  for (let j = 0; j < body.length; j++) {
    if (isW(body[j], 'excluded') && isOp(body[nx(body, j)], '.')) {
      const c = nx(body, nx(body, j))
      body = splice(body, j, c, [W('VALUES'), raw('('), body[c], raw(')')])
    }
  }
  const mid = [W('ON DUPLICATE KEY UPDATE'), SP, ...trimWs(body)]
  return { a: [...a.slice(0, pv(a, i) + 1), SP, ...mid, ...(retIdx < 0 ? [] : [SP, ...a.slice(retIdx)])], doNothing: false }
}

/**
 * NULL na ordenação igual ao Postgres: lá NULL vem por ÚLTIMO no ASC e
 * PRIMEIRO no DESC; no MariaDB é o contrário. Uma chave "x IS NULL" antes de
 * cada item resolve — e é dispensada quando a coluna é NOT NULL (sem custo
 * nas tabelas grandes, que ordenam por created_at).
 */
function passOrderNulls(a: Tok[], opts: TranslateOpts): Tok[] {
  let out = a
  let from = 0
  for (;;) {
    const i = out.findIndex((t, j) => j >= from && isW(t, 'order') && isW(out[nx(out, j)], 'by'))
    if (i < 0) return out
    const by = nx(out, i)
    // fim da lista: palavra-chave de profundidade 0 ou ")" que fecha o grupo
    let d = 0
    let end = out.length
    for (let j = by + 1; j < out.length; j++) {
      const t = out[j]
      if (isOp(t, '(') || isW(t, 'case')) d++
      else if (isOp(t, ')') || isW(t, 'end')) { if (d === 0) { end = j; break } d-- }
      else if (d === 0 && (isW(t, 'limit', 'offset', 'for', 'fetch', 'union', 'except', 'intersect', 'separator') || isOp(t, ';'))) { end = j; break }
      else if (d === 0 && isW(t, 'rows', 'range') && !isOp(out[pv(out, j)], '.')
        && (isW(out[nx(out, j)], 'between', 'unbounded', 'current') || out[nx(out, j)]?.k === 'num')) { end = j; break }
    }
    const items = splitTop(out, by + 1, end)
    const rebuilt: Tok[] = []
    for (const [s, e] of items) {
      let it = trimWs(out.slice(s, e))
      let nulls: 'first' | 'last' | null = null
      const lastW = lw(it[it.length - 1])
      if ((lastW === 'first' || lastW === 'last') && isW(it[pv(it, it.length - 1)], 'nulls')) {
        nulls = lastW as 'first' | 'last'
        it = trimWs(it.slice(0, pv(it, it.length - 1)))
      }
      let dir: 'asc' | 'desc' = 'asc'
      if (isW(it[it.length - 1], 'asc', 'desc')) {
        dir = lw(it[it.length - 1]) as 'asc' | 'desc'
        it = trimWs(it.slice(0, it.length - 1))
      }
      const wantNullsLast = nulls ? nulls === 'last' : dir === 'asc'
      const mariaNullsLast = dir === 'desc'
      const positional = it.length === 1 && it[0].k === 'num'
      const col = it.length >= 1 && it.every((t, idx) => (idx % 2 === 1 ? isOp(t, '.') : t.k === 'w' || t.k === 'qid'))
        ? (it[it.length - 1].k === 'qid' ? it[it.length - 1].v.slice(1, -1) : lw(it[it.length - 1]))
        : null
      const needKey = !positional && wantNullsLast !== mariaNullsLast && !(col && opts.notNull(col))
      if (rebuilt.length) rebuilt.push(raw(', '))
      if (needKey) rebuilt.push(raw('('), ...it, raw(' IS NULL)'), raw(wantNullsLast ? ' ASC' : ' DESC'), raw(', '))
      rebuilt.push(...it, raw(dir === 'desc' ? ' DESC' : ''))
    }
    out = [...out.slice(0, by + 1), SP, ...rebuilt, ...(end < out.length ? [SP] : []), ...out.slice(end)]
    from = by + 1
  }
}

function passLimit(a: Tok[], kinds: Map<number, ParamKind>): Tok[] {
  let out = a
  for (let j = 0; j < out.length; j++) {
    if (!isW(out[j], 'limit', 'offset')) continue
    const v = nx(out, j)
    if (v < 0) continue
    if (out[v].k === 'par') kinds.set(out[v].n!, 'int')
    if (isW(out[j], 'limit') && isW(out[v], 'all')) { out = splice(out, j, v, []); j--; continue }
    if (isW(out[j], 'offset')) {
      // OFFSET sem LIMIT não existe no MariaDB
      let d = 0
      let hasLimit = false
      for (let q = j - 1; q >= 0; q--) {
        if (isOp(out[q], ')')) d++
        else if (isOp(out[q], '(')) { if (d === 0) break; d-- }
        else if (d === 0 && isW(out[q], 'limit')) { hasLimit = true; break }
        else if (d === 0 && isW(out[q], 'select')) break
      }
      if (!hasLimit) { out = [...out.slice(0, j), raw('LIMIT 18446744073709551615 '), ...out.slice(j)]; j++ }
    }
  }
  return out
}

// Colunas do esquema que são palavras reservadas no MariaDB.
// (lista conferida contra as colunas de todas as tabelas; nome novo que colida
// com palavra reservada do MariaDB entra aqui)
const RESERVED = new Set(['key', 'sql', 'database', 'trigger', 'rows', 'ssl', 'sensitive'])
function passReserved(a: Tok[]): Tok[] {
  return a.map((t, j) => {
    if (t.k !== 'w' || !RESERVED.has(lw(t))) return t
    const n1 = nx(a, j)
    const p1 = pv(a, j)
    if (n1 >= 0 && isOp(a[n1], '(')) return t // função (database(), interval(…))
    const v = lw(t)
    if (v === 'key' && isW(a[p1], 'primary', 'foreign', 'unique', 'duplicate')) return t
    if (v === 'rows' && (isW(a[n1], 'between', 'only') || isW(a[p1], 'first', 'next') || a[p1]?.k === 'num')) return t
    return { k: 'qid', v: `"${v}"` } as Tok
  })
}

// ── UPDATE … RETURNING ───────────────────────────────────────────────────
function planUpdateReturning(a: Tok[], sql: string, opts: TranslateOpts, render: (t: Tok[]) => Seg[]): UpdateReturningPlan {
  const tIdx = nx(a, 0)
  if (!(a[tIdx].k === 'w' || a[tIdx].k === 'qid')) throw new UnsupportedSqlError('update sem tabela', sql)
  let table = a[tIdx].k === 'qid' ? a[tIdx].v.slice(1, -1) : lw(a[tIdx])
  let after = tIdx
  if (isOp(a[nx(a, tIdx)], '.')) { after = nx(a, nx(a, tIdx)); table = lw(a[after]) }
  let alias: string | null = null
  let setIdx = nx(a, after)
  if (isW(a[setIdx], 'as')) setIdx = nx(a, setIdx)
  if (!isW(a[setIdx], 'set')) { alias = a[setIdx].v; setIdx = nx(a, setIdx) }
  if (!isW(a[setIdx], 'set')) throw new UnsupportedSqlError('update sem set', sql)
  const ret = findTop(a, setIdx, a.length, (t) => isW(t, 'returning'))
  const where = findTop(a, setIdx, ret, (t) => isW(t, 'where'))
  if (findTop(a, setIdx, where < 0 ? ret : where, (t) => isW(t, 'from')) >= 0) throw new UnsupportedSqlError('update … from', sql)
  const pk = opts.pk(table)
  if (!pk?.length) throw new UnsupportedSqlError(`update … returning em tabela sem chave conhecida (${table})`, sql)
  const head = a.slice(0, setIdx) // "update tabela [alias]"
  const target = trimWs(a.slice(tIdx, setIdx))
  const setList = a.slice(setIdx, where < 0 ? ret : where)
  const whereClause = where < 0 ? [] : a.slice(where, ret)
  const q = (c: string) => (alias ? `${alias}.` : '') + `"${c}"`
  const keyExpr = pk.length === 1 ? q(pk[0]) : `(${pk.map(q).join(', ')})`
  const ids: Tok = { k: 'ids', v: '' }
  const retList = a.slice(nx(a, ret))
  return {
    pk,
    lock: render([raw(`SELECT ${pk.map(q).join(', ')} FROM `), ...target, SP, ...whereClause, raw(' FOR UPDATE')]),
    update: render([...head, ...setList, raw(` WHERE ${keyExpr} IN `), ids]),
    select: render([raw('SELECT '), ...retList, raw(' FROM '), ...target, raw(` WHERE ${keyExpr} IN `), ids]),
  }
}

// ── Montagem ──────────────────────────────────────────────────────────────
function render(a: Tok[], kinds: Map<number, ParamKind>): Seg[] {
  const segs: Seg[] = []
  let buf = ''
  const flush = () => { if (buf) { segs.push(buf); buf = '' } }
  for (const t of a) {
    switch (t.k) {
      case 'par': flush(); segs.push({ p: t.n!, kind: t.pk ?? kinds.get(t.n!) ?? 'value', ...(t.neg ? { neg: true } : {}) }); break
      case 'ids': flush(); segs.push({ ids: true }); break
      // literal comum: no Postgres a barra é literal; no MariaDB é escape
      case 'str': buf += `'${t.v.replace(/\\/g, '\\\\')}'`; break
      case 'estr': buf += `'${t.v}'`; break
      default: buf += t.v
    }
  }
  flush()
  return segs
}

const TX = /^\s*(begin|start\s+transaction|commit|rollback|end)\s*;?\s*$/i

export function translate(sql: string, opts: TranslateOpts): Translated {
  const tx = TX.exec(sql)
  if (tx) {
    const w = tx[1].toLowerCase()
    return { kind: 'tx', segs: [w === 'begin' || w.startsWith('start') ? 'BEGIN' : w === 'rollback' ? 'ROLLBACK' : 'COMMIT'], hints: {} }
  }
  let a = tokenize(sql)
  rejectUnsupported(a, sql)
  const first = lw(a[0])
  const kinds = new Map<number, ParamKind>()

  // nomes e tipos do resultado (no SQL ainda em Postgres)
  let hints: Record<string, Hint> = {}
  const retIdx = findTop(a, 0, a.length, (t) => isW(t, 'returning'))
  const listStart = first === 'select' || first === 'with' ? resultSelect(a) : retIdx
  if (listStart >= 0 && (first !== 'with' || isW(a[listStart], 'select'))) {
    const r = applyResultNames(a, listStart)
    a = r.a
    hints = r.hints
  }

  a = passJsonPaths(a, sql)
  a = passCasts(a, sql, kinds)
  inferDatetimeParams(a, kinds, opts)
  a = passAnyAll(a, sql, kinds)
  a = passIlike(a, sql)
  a = passIntervals(a, sql)
  a = passFunctions(a, sql)
  a = passOrderNulls(a, opts)
  a = passLimit(a, kinds)
  a = passReserved(a)
  const c = passConflict(a, sql)
  a = c.a

  if (first === 'update' && findTop(a, 0, a.length, (t) => isW(t, 'returning')) >= 0) {
    const upd = planUpdateReturning(a, sql, opts, (t) => render(t, kinds))
    return { kind: 'update-returning', segs: [], hints, upd }
  }
  if (first === 'delete' && findTop(a, 0, a.length, (t) => isW(t, 'using')) >= 0) throw new UnsupportedSqlError('delete … using', sql)
  if (first === 'update') {
    const setIdx = findTop(a, 0, a.length, (t) => isW(t, 'set'))
    const whereIdx = findTop(a, setIdx, a.length, (t) => isW(t, 'where'))
    if (setIdx >= 0 && findTop(a, setIdx, whereIdx < 0 ? a.length : whereIdx, (t) => isW(t, 'from')) >= 0) {
      throw new UnsupportedSqlError('update … from', sql)
    }
  }
  return { kind: c.doNothing ? 'insert-do-nothing' : 'plain', segs: render(a, kinds), hints }
}

/** Divide um arquivo de migration em comandos (respeitando literais e comentários). */
export function splitStatements(sqlText: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  const n = sqlText.length
  while (i < n) {
    const c = sqlText[i]
    if (c === '-' && sqlText[i + 1] === '-') { const j = sqlText.indexOf('\n', i); i = j < 0 ? n : j; continue }
    if (c === '/' && sqlText[i + 1] === '*') { const j = sqlText.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n && !(sqlText[j] === c && sqlText[j + 1] !== c)) { if (sqlText[j] === c) j++; if (c === "'" && sqlText[j] === '\\') j++; j++ }
      buf += sqlText.slice(i, j + 1); i = j + 1; continue
    }
    if (c === ';') { if (buf.trim()) out.push(buf.trim()); buf = ''; i++; continue }
    buf += c; i++
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}
