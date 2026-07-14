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

export interface Compiled {
  sql: string
  countSql: string | null // total sem limit/offset (só quando não há groupBy)
  params: unknown[]
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
  opts: { admin: boolean; glob: string },
): Compiled {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const params: unknown[] = []

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
    if ('metric' in sel) throw new Error('Métricas da biblioteca chegam no Sprint 5.')
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
    where.push(filterExpr(flt))
  }
  function filterExpr(flt: QueryFilter): string {
    const f = resolve(flt.field, 'filtro')
    const col = qid(f.key)
    switch (flt.op) {
      case 'is_null': return `${col} is null`
      case 'not_null': return `${col} is not null`
      case 'contains': params.push(`%${String(flt.value ?? '')}%`); return `${col} ilike ?`
      case 'starts_with': params.push(`${String(flt.value ?? '')}%`); return `${col} ilike ?`
      case 'in':
      case 'not_in': {
        const list = Array.isArray(flt.value) ? flt.value : [flt.value]
        if (!list.length) return flt.op === 'in' ? 'false' : 'true'
        const ph = list.map((v) => { params.push(v); return '?' })
        return `${col} ${flt.op === 'in' ? 'in' : 'not in'} (${ph.join(', ')})`
      }
      case 'between': {
        const [a, b] = Array.isArray(flt.value) ? flt.value : [null, null]
        params.push(a, b)
        return `${col} between ? and ?`
      }
      default: {
        const op = OPS[flt.op]
        if (!op) throw new Error(`Operador inválido: ${flt.op}`)
        params.push(flt.value)
        return `${col} ${op} ?`
      }
    }
  }

  // Busca livre: OR de ILIKE nos campos texto visíveis (não sensíveis p/ não-admin).
  if (def.search?.trim()) {
    const textFields = fields.filter((f) => f.type === 'text' && (opts.admin || !f.sensitive))
    if (textFields.length) {
      // Um parâmetro por campo (placeholders ? são estritamente posicionais).
      const term = `%${def.search.trim()}%`
      where.push('(' + textFields.map((f) => { params.push(term); return `cast(${qid(f.key)} as varchar) ilike ?` }).join(' or ') + ')')
    }
  }

  // ── GROUP BY / ORDER BY / LIMIT ──────────────────────────────
  const groupBy = (def.groupBy ?? []).map((k) => qid(resolve(k, 'agrupamento').key))
  const orderBy = (def.orderBy ?? []).map((o) => {
    // Ordena por alias do select OU por campo do catálogo.
    if (!aliases.has(o.field)) resolve(o.field, 'ordenação')
    return `${qid(o.field)} ${o.dir === 'desc' ? 'desc' : 'asc'}`
  })

  const limit = Math.min(Math.max(1, def.limit ?? 100), MAX_LIMIT)
  const offset = Math.max(0, def.offset ?? 0)

  const fromWhere = `from read_parquet('${opts.glob.replace(/'/g, '')}')` +
    (where.length ? ` where ${where.join(' and ')}` : '')

  const sql = `select ${select} ${fromWhere}` +
    (groupBy.length ? ` group by ${groupBy.join(', ')}` : '') +
    (orderBy.length ? ` order by ${orderBy.join(', ')}` : '') +
    ` limit ${limit} offset ${offset}`

  // Total (para paginação) — só faz sentido sem agrupamento.
  const countSql = groupBy.length ? null : `select count(*) as n ${fromWhere}`

  return { sql, countSql, params }
}
