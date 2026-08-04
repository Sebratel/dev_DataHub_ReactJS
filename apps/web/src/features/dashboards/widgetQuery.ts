// Monta o QueryDef de um widget a partir do modelo RICO (spec) com fallback ao
// legado (dimension/metric). Suporta múltiplas dimensões (agrupamento composto),
// múltiplas medidas (séries), pivô por legenda, combo (barra+linha) e dispersão.
import type { Widget, QueryDef, QueryFilter, QuerySelect, MeasureConfig, Aggregation } from '@datahub/shared'

export const VALUE = 'valor'

export function widgetDims(w: Widget): string[] {
  if (w.spec?.dimensions?.length) return w.spec.dimensions
  return w.dimension ? [w.dimension] : []
}

export function legacyMeasure(w: Widget): MeasureConfig | null {
  const m = w.metric as { metric?: string; field?: string; agg?: Aggregation } | undefined
  if (m?.metric) return { metric: m.metric }
  if (m?.field && m?.agg) return { field: m.field, agg: m.agg }
  return null
}

export function widgetMeasures(w: Widget): MeasureConfig[] {
  if (w.spec?.measures?.length) return w.spec.measures
  const lm = legacyMeasure(w)
  return lm ? [lm] : []
}

export function measureName(m: MeasureConfig, i: number): string {
  return m.label || m.field || m.metric || `Série ${i + 1}`
}

function measureSel(m: MeasureConfig, alias: string): QuerySelect {
  return m.metric
    ? { metric: m.metric, as: alias }
    : { field: m.field as string, agg: m.agg as Aggregation, as: alias }
}

// Monta o QueryDef. Retorna null para 'text' (não consulta nada).
export function buildWidgetQuery(w: Widget, extra?: QueryFilter[]): QueryDef | null {
  if (w.type === 'text') return null
  const slug = w.datasetSlug
  const dims = widgetDims(w)
  const measures = widgetMeasures(w)
  if (!measures.length) return null
  const legend = w.spec?.legendDimension
  const limit = w.spec?.limit
  const filters: QueryFilter[] = [
    ...(w.filters ?? []), ...(w.spec?.widgetFilters ?? []), ...(extra ?? []),
  ]

  if (w.type === 'kpi') {
    return { dataset: slug, select: [measureSel(measures[0], VALUE)], filters, limit: 1 }
  }

  if (w.type === 'scatter') {
    const x = w.spec?.measureX
    const select: QuerySelect[] = [
      ...dims, ...(x ? [measureSel(x, 'x')] : []), measureSel(measures[0], VALUE),
    ]
    return { dataset: slug, select, filters, groupBy: dims, limit: limit ?? 200 }
  }

  // Séries por LEGENDA (pivô): 1 medida quebrada pelos valores da legenda.
  if (legend) {
    return {
      dataset: slug,
      select: [...dims, legend, measureSel(measures[0], VALUE)],
      filters, groupBy: [...dims, legend],
      orderBy: [{ field: VALUE, dir: 'desc' }],
      limit: limit ?? 1000,
    }
  }

  // Séries por MÚLTIPLAS medidas (barras m0..; linhas l0.. no combo).
  const lineMeasures = w.spec?.measuresLine ?? []
  const select: QuerySelect[] = [
    ...dims,
    ...measures.map((m, i) => measureSel(m, `m${i}`)),
    ...lineMeasures.map((m, i) => measureSel(m, `l${i}`)),
  ]
  const isTime = w.type === 'line' || w.type === 'area' || w.type === 'comboBarLine'
  const orderBy = dims.length
    ? (isTime ? [{ field: dims[0], dir: 'asc' as const }] : [{ field: 'm0', dir: 'desc' as const }])
    : undefined
  const defLimit = w.type === 'pie' || w.type === 'funnel' ? 8 : w.type === 'table' ? 50 : 100
  return { dataset: slug, select, filters, groupBy: dims, orderBy, limit: limit ?? defLimit }
}

// Rótulo composto da categoria (X) juntando as dimensões.
export function categoryLabel(row: Record<string, unknown>, dims: string[]): string {
  if (!dims.length) return ''
  return dims.map((d) => String(row[d] ?? '—')).join(' · ')
}
