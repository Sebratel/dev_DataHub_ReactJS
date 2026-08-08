// Widget do dashboard: monta o QueryDef (modelo rico) e renderiza por tipo.
// Suporta séries (múltiplas medidas ou pivô por legenda), combo barra+linha,
// barras horizontais/empilhadas, dispersão, funil, tabela, KPI e texto.
// Specs de marca: linhas 2px, barras arredondadas no topo, grade recessiva,
// tooltip sempre presente, legenda quando há mais de uma série.
import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer, ComposedChart, Bar, Line, Area,
  PieChart, Pie, Cell, ScatterChart, Scatter, FunnelChart, Funnel,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList, ReferenceLine,
} from 'recharts'
import { GripVertical, Loader2, Maximize2, Minimize2, Pencil, Trash2, Sparkles, AlertTriangle, TrendingUp, RefreshCw, X } from 'lucide-react'
import clsx from 'clsx'
import type { Widget, QueryResult, Metric, ConditionalRule, QueryFilter, WidgetInsight } from '@datahub/shared'
import { api } from '@/lib/api'
import { palette, vizTokens, formatValue } from '@/lib/viz'
import { useThemeStore } from '@/store/themeStore'
import { buildWidgetQuery, widgetDims, widgetMeasures, measureName, categoryLabel, VALUE } from './widgetQuery'

interface SeriesDef { key: string; name: string; color: string; kind: 'bar' | 'line' | 'area' }

// Primeira regra de formatação condicional satisfeita → sua cor.
function condColor(v: number, rules?: ConditionalRule[]): string | undefined {
  if (!rules?.length || Number.isNaN(v)) return undefined
  for (const r of rules) {
    const ok =
      r.op === '>' ? v > r.value : r.op === '>=' ? v >= r.value :
      r.op === '<' ? v < r.value : r.op === '<=' ? v <= r.value :
      r.op === '=' ? v === r.value : v !== r.value
    if (ok) return r.color
  }
  return undefined
}

interface Props {
  widget: Widget
  /** Necessário para pedir o insight (a rota e por painel). */
  dashboardId?: string
  metrics: Metric[]
  editable: boolean
  onDelete: () => void
  onResize?: (size: Widget['size']) => void
  onEdit?: () => void
  dragHandleProps?: Record<string, unknown>
  fill?: boolean
  dashboardPalette?: string[]
  extraFilters?: QueryFilter[]
  refreshKey?: number
}

export default function WidgetCard({ widget, dashboardId, metrics, editable, onDelete, onResize, onEdit, dragHandleProps, fill, dashboardPalette, extraFilters, refreshKey }: Props) {
  const theme = useThemeStore((s) => s.theme)
  const style = widget.style ?? {}
  const base = style.palette?.length ? style.palette : (dashboardPalette?.length ? dashboardPalette : palette(theme))
  const tokens = vizTokens(theme)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Insight da IA. Fica FECHADO por padrao: e uma leitura sob demanda, nao um
  // enfeite — gerar para todo widget ao abrir o painel gastaria uma chamada ao
  // provedor por grafico, toda vez.
  const [insight, setInsight] = useState<WidgetInsight | null>(null)
  const [insightOpen, setInsightOpen] = useState(false)
  const [insightLoading, setInsightLoading] = useState(false)
  const [insightError, setInsightError] = useState<string | null>(null)

  const metricDef = 'metric' in (widget.metric ?? {})
    ? metrics.find((m) => m.slug === (widget.metric as { metric: string }).metric)
    : undefined
  const format = style.numberFormat ?? metricDef?.format ?? 'number'
  const decimals = style.decimals
  const fmt = (v: unknown) => formatValue(v, format, decimals)
  const dims = widgetDims(widget)
  const measures = widgetMeasures(widget)
  const isText = widget.type === 'text'
  const showLegend = style.showLegend ?? (widget.type === 'pie' || measures.length > 1 || !!widget.spec?.legendDimension)
  const showLabels = style.showDataLabels ?? false

  const extraKey = JSON.stringify(extraFilters ?? [])
  useEffect(() => {
    if (isText) { setResult(null); setError(null); return }
    const def = buildWidgetQuery(widget, extraFilters)
    if (!def) { setError('Widget sem medida.'); return }
    setResult(null)
    setError(null)
    api<QueryResult>(`/api/v1/datasets/${widget.datasetSlug}/query`, { method: 'POST', body: JSON.stringify(def) })
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha na consulta.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id, widget.datasetSlug, JSON.stringify(widget.spec), JSON.stringify(widget.metric), widget.type, extraKey, refreshKey])

  const rows = useMemo<Record<string, unknown>[]>(() => (result?.rows ?? []) as Record<string, unknown>[], [result])

  // Categoria (X) + linhas com rótulo composto das dimensões.
  const catRows = useMemo<Record<string, unknown>[]>(
    () => rows.map((r) => ({ ...r, _dim: categoryLabel(r, dims) })), [rows, dims])

  // Séries + dados normalizados (para gráficos de eixo, pizza e funil).
  const { data, series } = useMemo(() => {
    const legend = widget.spec?.legendDimension
    const lineMeasures = widget.spec?.measuresLine ?? []
    const seriesKind = (idx: 'bar' | 'line' | 'area'): 'bar' | 'line' | 'area' => idx
    const kindFor = widget.type === 'line' ? 'line' : widget.type === 'area' ? 'area' : 'bar'

    if (legend) {
      const vals: string[] = []
      for (const r of rows) { const v = String(r[legend] ?? '—'); if (!vals.includes(v)) vals.push(v) }
      const top = vals.slice(0, 8)
      const byDim = new Map<string, Record<string, unknown>>()
      for (const r of catRows) {
        const k = String(r._dim)
        if (!byDim.has(k)) byDim.set(k, { _dim: k })
        const o = byDim.get(k)!
        o[String(r[legend] ?? '—')] = Number(r[VALUE] ?? 0)
      }
      const s: SeriesDef[] = top.map((v, i) => ({ key: v, name: v, color: base[i % base.length], kind: seriesKind(kindFor) }))
      return { data: [...byDim.values()], series: s }
    }

    const barSeries: SeriesDef[] = measures.map((m, i) => ({
      key: `m${i}`, name: measureName(m, i),
      color: m.color || (i === 0 && style.color ? style.color : base[i % base.length]),
      kind: widget.type === 'comboBarLine' ? 'bar' : kindFor,
    }))
    const lineSeries: SeriesDef[] = lineMeasures.map((m, i) => ({
      key: `l${i}`, name: measureName(m, i),
      color: m.color || base[(measures.length + i) % base.length], kind: 'line',
    }))
    const s = [...barSeries, ...lineSeries]
    const d = catRows.map((r) => {
      const o: Record<string, unknown> = { _dim: r._dim }
      for (const ser of s) o[ser.key] = Number(r[ser.key] ?? 0)
      return o
    })
    return { data: d, series: s }
  }, [catRows, rows, measures, widget.type, widget.spec, base, style.color])

  const tooltipStyle = { backgroundColor: tokens.surface, border: `1px solid ${tokens.grid}`, borderRadius: 8, fontSize: 12, color: tokens.text }
  const axisProps = { stroke: tokens.axis, fontSize: 11, tickLine: false as const, axisLine: { stroke: tokens.grid } }
  const labelProps = { fontSize: 10, fill: tokens.text, formatter: (v: unknown) => fmt(v) }
  const target = typeof style.target === 'number' ? style.target : undefined

  function renderAxisChart() {
    const horizontal = widget.type === 'barH' || widget.type === 'barHStacked'
    const stacked = widget.type === 'barStacked' || widget.type === 'barHStacked'
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={tokens.grid} vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" {...axisProps} tickFormatter={(v) => fmt(v)} />
              <YAxis type="category" dataKey="_dim" {...axisProps} width={90} />
            </>
          ) : (
            <>
              <XAxis dataKey="_dim" {...axisProps} minTickGap={16} />
              <YAxis type="number" {...axisProps} width={52} tickFormatter={(v) => fmt(v)} />
            </>
          )}
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(v)} cursor={{ fill: tokens.grid, opacity: 0.35 }} />
          {showLegend && <Legend wrapperStyle={{ fontSize: 11, color: tokens.text }} iconSize={9} />}
          {target !== undefined && <ReferenceLine {...(horizontal ? { x: target } : { y: target })} stroke={tokens.axis} strokeDasharray="4 3" />}
          {series.map((s) => s.kind === 'bar' ? (
            <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} stackId={stacked ? 'a' : undefined}
              radius={stacked ? 0 : (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0])}>
              {showLabels && <LabelList dataKey={s.key} position={horizontal ? 'right' : 'top'} {...labelProps} />}
            </Bar>
          ) : s.kind === 'area' ? (
            <Area key={s.key} dataKey={s.key} name={s.name} stroke={s.color} fill={s.color} fillOpacity={0.18} strokeWidth={2}>
              {showLabels && <LabelList dataKey={s.key} position="top" {...labelProps} />}
            </Area>
          ) : (
            <Line key={s.key} dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }}>
              {showLabels && <LabelList dataKey={s.key} position="top" {...labelProps} />}
            </Line>
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    )
  }

  function renderChart() {
    if (isText) {
      return <div className="h-full overflow-auto whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">{widget.spec?.content ?? ''}</div>
    }
    if (widget.type === 'kpi') {
      const v = Number(rows[0]?.[VALUE] ?? 0)
      const cc = condColor(v, style.conditionalRules)
      return (
        <div className="flex h-full flex-col items-start justify-center px-1">
          <span className="text-[19px] font-semibold tabular-nums" style={cc ? { color: cc } : undefined}>{fmt(rows[0]?.[VALUE])}</span>
        </div>
      )
    }
    if (widget.type === 'table') {
      return (
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-zinc-400">
                <th className="py-1 pr-3 font-medium">Categoria</th>
                {series.map((s) => <th key={s.key} className="py-1 pl-3 text-right font-medium">{s.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.map((r, i) => (
                <tr key={i} className="border-t border-zinc-100 first:border-0 dark:border-zinc-800">
                  <td className="max-w-[180px] truncate py-1.5 pr-3">{String(r._dim)}</td>
                  {series.map((s) => {
                    const cc = condColor(Number(r[s.key]), style.conditionalRules)
                    return <td key={s.key} className="py-1.5 pl-3 text-right tabular-nums" style={cc ? { color: cc, fontWeight: 600 } : undefined}>{fmt(r[s.key])}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    if (widget.type === 'pie' || widget.type === 'funnel') {
      const pieData = catRows.map((r) => ({ _dim: r._dim, valor: Number(r.m0 ?? 0) }))
      if (widget.type === 'funnel') {
        return (
          <ResponsiveContainer width="100%" height="100%">
            <FunnelChart>
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(v)} />
              <Funnel dataKey="valor" data={pieData} isAnimationActive>
                {showLabels && <LabelList position="right" fill={tokens.text} stroke="none" dataKey="_dim" fontSize={11} />}
                {pieData.map((_, i) => <Cell key={i} fill={base[i % base.length]} />)}
              </Funnel>
            </FunnelChart>
          </ResponsiveContainer>
        )
      }
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={pieData} dataKey="valor" nameKey="_dim" innerRadius="55%" outerRadius="85%"
              stroke={tokens.surface} strokeWidth={2} label={showLabels ? ({ value }) => fmt(value) : undefined}>
              {pieData.map((_, i) => <Cell key={i} fill={base[i % base.length]} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(v)} />
            {showLegend && <Legend wrapperStyle={{ fontSize: 11, color: tokens.text }} iconSize={9} />}
          </PieChart>
        </ResponsiveContainer>
      )
    }
    if (widget.type === 'scatter') {
      const pts = catRows.map((r) => ({ _dim: r._dim, x: Number(r.x ?? 0), valor: Number(r[VALUE] ?? 0) }))
      return (
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={tokens.grid} />
            <XAxis type="number" dataKey="x" {...axisProps} tickFormatter={(v) => fmt(v)} />
            <YAxis type="number" dataKey="valor" {...axisProps} width={52} tickFormatter={(v) => fmt(v)} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(v)} cursor={{ stroke: tokens.grid }} />
            <Scatter data={pts} fill={style.color || base[0]} />
          </ScatterChart>
        </ResponsiveContainer>
      )
    }
    // bar / barH / stacked / line / area / combo
    return renderAxisChart()
  }

  async function askInsight(force = false) {
    const def = buildWidgetQuery(widget, extraFilters)
    if (!def || !dashboardId) return
    setInsightOpen(true)
    setInsightLoading(true)
    setInsightError(null)
    try {
      setInsight(await api<WidgetInsight>(
        `/api/v1/dashboards/${dashboardId}/widgets/${widget.id}/insight`,
        { method: 'POST', body: JSON.stringify({ query: def, force }) },
      ))
    } catch (e) {
      setInsightError(e instanceof Error ? e.message : 'Falha ao gerar o insight.')
    } finally {
      setInsightLoading(false)
    }
  }

  const heightCls = isText ? 'h-40' : widget.type === 'kpi' ? 'h-24' : (widget.type === 'pie' || widget.type === 'funnel') ? 'h-64' : 'h-56'

  return (
    <div className={clsx('flex flex-col rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900', fill && 'h-full')}>
      <div className="mb-2 flex items-center gap-1.5">
        {editable && (
          <span {...dragHandleProps} className={clsx('text-zinc-300 dark:text-zinc-600', fill ? 'widget-drag cursor-grab' : 'cursor-grab')} title="Arrastar">
            <GripVertical size={14} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{widget.title || metricDef?.name || 'Widget'}</h3>
          {style.subtitle && <p className="truncate text-[11px] text-zinc-400">{style.subtitle}</p>}
        </div>
        {!isText && dashboardId && (
          <button
            onClick={() => (insightOpen ? setInsightOpen(false) : void askInsight())}
            disabled={insightLoading || !result}
            title="Analisar com IA"
            className={clsx('rounded p-1 transition-colors disabled:opacity-40',
              insightOpen ? 'text-accent' : 'text-zinc-300 hover:text-accent dark:text-zinc-600')}
          >
            {insightLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          </button>
        )}
        {editable && (
          <span className="flex gap-1">
            {onEdit && (
              <button onClick={onEdit} className="rounded p-1 text-zinc-300 hover:text-accent dark:text-zinc-600" title="Editar widget"><Pencil size={13} /></button>
            )}
            {!fill && onResize && (
              <button onClick={() => onResize(widget.size === 'lg' ? 'md' : 'lg')}
                className="rounded p-1 text-zinc-300 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-300"
                title={widget.size === 'lg' ? 'Diminuir' : 'Ampliar'}>
                {widget.size === 'lg' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            )}
            <button onClick={onDelete} className="rounded p-1 text-zinc-300 hover:text-red-500 dark:text-zinc-600" title="Remover widget"><Trash2 size={13} /></button>
          </span>
        )}
      </div>
      <div className={fill ? 'min-h-0 flex-1' : heightCls}>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!isText && !result && !error && (
          <div className="flex h-full items-center justify-center text-zinc-400"><Loader2 size={16} className="animate-spin" /></div>
        )}
        {isText ? renderChart() : (result && !error && renderChart())}
      </div>

      {insightOpen && (
        <div className="mt-2 shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-950/40">
          <div className="mb-1 flex items-center gap-1.5">
            {insight?.tone === 'attention'
              ? <AlertTriangle size={12} className="shrink-0 text-warn dark:text-warn-dark" />
              : insight?.tone === 'positive'
                ? <TrendingUp size={12} className="shrink-0 text-ok dark:text-ok-dark" />
                : <Sparkles size={12} className="shrink-0 text-accent" />}
            <span className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">
              Leitura da IA
            </span>
            <span className="ml-auto flex items-center gap-1">
              {insight && (
                <button onClick={() => void askInsight(true)} disabled={insightLoading}
                  title="Gerar de novo" className="rounded p-0.5 text-zinc-400 hover:text-zinc-900 disabled:opacity-40 dark:hover:text-zinc-100">
                  <RefreshCw size={11} />
                </button>
              )}
              <button onClick={() => setInsightOpen(false)} title="Fechar"
                className="rounded p-0.5 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100">
                <X size={11} />
              </button>
            </span>
          </div>

          {insightLoading && (
            <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Loader2 size={11} className="animate-spin" /> Lendo os números…
            </p>
          )}
          {insightError && <p className="text-[11px] leading-relaxed text-crit dark:text-crit-dark">{insightError}</p>}

          {insight && !insightLoading && (
            <>
              <p className="text-[12px] font-medium leading-relaxed">{insight.headline}</p>
              {insight.bullets.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {insight.bullets.map((b, i) => (
                    <li key={i} className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">{b}</li>
                  ))}
                </ul>
              )}
              <p className="mt-1.5 text-[9.5px] text-zinc-400">
                {insight.cached
                  ? 'mesmos dados de antes — texto reaproveitado'
                  : `${insight.provider} · ${insight.model} · ${insight.tookMs} ms`}
                {' · '}gerado por IA, confira antes de decidir
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
