// ─────────────────────────────────────────────────────────────────────────
// Compilador QueryDef → SQL DuckDB sobre o lake. Segurança:
//   • todo campo referenciado precisa existir no catálogo (whitelist);
//   • campos ocultos não existem para o compilador;
//   • campos sensíveis: SELECT devolve máscara; filtrar/agrupar/ordenar por
//     eles é bloqueado para não-admins (canal de vazamento);
//   • valores de filtro viram parâmetros preparados — nunca interpolados.
// ─────────────────────────────────────────────────────────────────────────
import type { QueryDef, QueryFilter, QuerySelect } from '@datahub/shared'

export interface CompileField {
  key: string
  type: string
  sensitive: boolean
}

// Métrica da biblioteca: agregação (opcionalmente filtrada) sobre um campo.
export interface CompileMetric {
  slug: string
  agg: string
  fieldKey: string
  filters: QueryFilter[]
}

export interface Compiled {
  sql: string
  countSql: string | null // total sem limit/offset (só quando não há groupBy)
  params: unknown[]       // parâmetros do sql completo (select + where, em ordem)
  countParams: unknown[]  // parâmetros só do where (para o countSql)
}

const OPS: Record<string, string> = {
  '=': '=', '!=': '<>', '>': '>', '>=': '>=', '<': '<', '<=': '<=',
}
const AGGS = new Set(['sum', 'avg', 'min', 'max', 'count', 'count_distinct'])
const MASK = '•••'
const MAX_LIMIT = 10_000

const qid = (s: string) => '"' + s.replace(/"/g, '') + '"'

export function compileQuery(
  def: QueryDef,
  fields: CompileField[],
  opts: {
    admin: boolean
    glob: string
    metrics?: CompileMetric[]
    /** Teto de linhas. Ausente = 10 mil (telas). `null` = sem teto (export). */
    maxLimit?: number | null
  },
): Compiled {
  const metricBySlug = new Map((opts.metrics ?? []).map((m) => [m.slug, m]))
  const byKey = new Map(fields.map((f) => [f.key, f]))
  // Placeholders ? são posicionais: no SQL o SELECT vem antes do WHERE, então
  // mantemos dois conjuntos — o countSql usa apenas os do WHERE.
  const selectParams: unknown[] = []
  const whereParams: unknown[] = []

  function resolve(key: string, usage: string): CompileField {
    const f = byKey.get(key)
    if (!f) throw new Error(`Campo desconhecido em ${usage}: "${key}"`)
    if (f.sensitive && !opts.admin && usage !== 'select') {
      throw new Error(`O campo "${key}" é sensível e não pode ser usado em ${usage}.`)
    }
    return f
  }

  // ── SELECT ───────────────────────────────────────────────────
  const aliases = new Set<string>()
  function selectExpr(sel: QuerySelect): string {
    if (typeof sel === 'string') {
      const f = resolve(sel, 'select')
      aliases.add(f.key)
      return f.sensitive && !opts.admin ? `'${MASK}' as ${qid(f.key)}` : qid(f.key)
    }
    if ('metric' in sel) {
      const m = metricBySlug.get(sel.metric)
      if (!m) throw new Error(`Métrica desconhecida para este dataset: "${sel.metric}"`)
      const f = resolve(m.fieldKey, 'agregação')
      if (f.sensitive && !opts.admin) throw new Error(`A métrica "${sel.metric}" usa um campo sensível.`)
      if (!AGGS.has(m.agg)) throw new Error(`Agregação inválida na métrica: ${m.agg}`)
      const alias = sel.as || sel.metric
      aliases.add(alias)
      const aggExpr = m.agg === 'count_distinct' ? `count(distinct ${qid(f.key)})` : `${m.agg}(${qid(f.key)})`
      // Filtros embutidos da métrica: FILTER (WHERE …) do DuckDB — a métrica
      // carrega a própria condição sem afetar o resto da consulta.
      const conds = m.filters.map((flt) => filterExpr(flt, selectParams))
      const filtered = conds.length ? `${aggExpr} filter (where ${conds.join(' and ')})` : aggExpr
      return `${filtered} as ${qid(alias)}`
    }
    const f = resolve(sel.field, 'agregação')
    if (!AGGS.has(sel.agg)) throw new Error(`Agregação inválida: ${sel.agg}`)
    if (f.sensitive && !opts.admin) throw new Error(`O campo "${f.key}" é sensível e não pode ser agregado.`)
    const alias = sel.as || `${sel.agg}_${f.key}`
    aliases.add(alias)
    const expr = sel.agg === 'count_distinct' ? `count(distinct ${qid(f.key)})` : `${sel.agg}(${qid(f.key)})`
    return `${expr} as ${qid(alias)}`
  }

  const select = def.select?.length
    ? def.select.map(selectExpr).join(', ')
    : fields.map((f) => {
        aliases.add(f.key)
        return f.sensitive && !opts.admin ? `'${MASK}' as ${qid(f.key)}` : qid(f.key)
      }).join(', ')

  // ── WHERE ────────────────────────────────────────────────────
  const where: string[] = []
  for (const flt of def.filters ?? []) {
    where.push(filterExpr(flt, whereParams))
  }
  function filterExpr(flt: QueryFilter, params: unknown[]): string {
    const f = resolve(flt.field, 'filtro')
    const col = qid(f.key)
    // O DuckDB não infere o tipo de parâmetros preparados neste contexto
    // (assume VARCHAR) — o cast explícito por tipo do catálogo resolve.
    const ph = f.type === 'number' ? 'cast(? as double)'
      : f.type === 'date' ? 'cast(? as timestamp)'
      : f.type === 'bool' ? 'cast(? as boolean)'
      : '?'
    switch (flt.op) {
      case 'is_null': return `${col} is null`
      case 'not_null': return `${col} is not null`
      case 'contains': params.push(`%${String(flt.value ?? '')}%`); return `cast(${col} as varchar) ilike ?`
      case 'starts_with': params.push(`${String(flt.value ?? '')}%`); return `cast(${col} as varchar) ilike ?`
      case 'in':
      case 'not_in': {
        const list = Array.isArray(flt.value) ? flt.value : [flt.value]
        if (!list.length) return flt.op === 'in' ? 'false' : 'true'
        const phs = list.map((v) => { params.push(v); return ph })
        return `${col} ${flt.op === 'in' ? 'in' : 'not in'} (${phs.join(', ')})`
      }
      case 'between': {
        const [a, b] = Array.isArray(flt.value) ? flt.value : [null, null]
        params.push(a, b)
        return `${col} between ${ph} and ${ph}`
      }
      default: {
        const op = OPS[flt.op]
        if (!op) throw new Error(`Operador inválido: ${flt.op}`)
        params.push(flt.value)
        return `${col} ${op} ${ph}`
      }
    }
  }

  // Busca livre: OR de ILIKE nos campos texto visíveis (não sensíveis p/ não-admin).
  if (def.search?.trim()) {
    const textFields = fields.filter((f) => f.type === 'text' && (opts.admin || !f.sensitive))
    if (textFields.length) {
      // Um parâmetro por campo (placeholders ? são estritamente posicionais).
      const term = `%${def.search.trim()}%`
      where.push('(' + textFields.map((f) => { whereParams.push(term); return `cast(${qid(f.key)} as varchar) ilike ?` }).join(' or ') + ')')
    }
  }

  // ── GROUP BY / ORDER BY / LIMIT ──────────────────────────────
  const groupBy = (def.groupBy ?? []).map((k) => qid(resolve(k, 'agrupamento').key))
  const orderBy = (def.orderBy ?? []).map((o) => {
    // Ordena por alias do select OU por campo do catálogo.
    if (!aliases.has(o.field)) resolve(o.field, 'ordenação')
    return `${qid(o.field)} ${o.dir === 'desc' ? 'desc' : 'asc'}`
  })

  // Teto de linhas. O padrão protege as telas interativas (ninguém rola 10 mil
  // linhas no navegador); `maxLimit: null` desliga o teto e NÃO emite cláusula
  // limit — é o que o export em streaming usa, porque lá o consumidor é um
  // arquivo, não uma tabela na tela.
  const cap = opts.maxLimit === undefined ? MAX_LIMIT : opts.maxLimit
  const limit = cap === null ? null : Math.min(Math.max(1, def.limit ?? 100), cap)
  const offset = Math.max(0, def.offset ?? 0)

  const fromWhere = `from read_parquet('${opts.glob.replace(/'/g, '')}')` +
    (where.length ? ` where ${where.join(' and ')}` : '')

  const sql = `select ${select} ${fromWhere}` +
    (groupBy.length ? ` group by ${groupBy.join(', ')}` : '') +
    (orderBy.length ? ` order by ${orderBy.join(', ')}` : '') +
    (limit === null ? (offset ? ` offset ${offset}` : '') : ` limit ${limit} offset ${offset}`)

  // Total (para paginação) — só faz sentido sem agrupamento.
  const countSql = groupBy.length ? null : `select count(*) as n ${fromWhere}`

  return { sql, countSql, params: [...selectParams, ...whereParams], countParams: whereParams }
}
