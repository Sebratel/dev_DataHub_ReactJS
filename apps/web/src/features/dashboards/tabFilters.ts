// Filtros no nível da aba: convertidos em QueryFilter e aplicados por cima dos
// filtros próprios de cada widget — mas SÓ nos widgets cujo conjunto
// (datasetSlug) é o mesmo do filtro (evita erro em widgets de outros conjuntos).
import type { QueryFilter, TabFilter } from '@datahub/shared'

export type FilterValue = string[] | { from: string; to: string }
export type FilterValues = Record<number, FilterValue>

// Filtros ativos que se aplicam a um widget de determinado conjunto.
export function tabQueryFilters(filters: TabFilter[], values: FilterValues, datasetSlug: string): QueryFilter[] {
  const out: QueryFilter[] = []
  filters.forEach((f, i) => {
    if (f.datasetSlug !== datasetSlug) return
    const v = values[i]
    if (!v) return
    if (f.kind === 'multiselect' && Array.isArray(v) && v.length) {
      out.push({ field: f.field, op: 'in', value: v })
    } else if (f.kind === 'daterange' && !Array.isArray(v) && v.from && v.to) {
      out.push({ field: f.field, op: 'between', value: [v.from, v.to] })
    }
  })
  return out
}
