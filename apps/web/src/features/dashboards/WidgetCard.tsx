// Widget do dashboard: monta o QueryDef a partir da definição salva, consulta
// o lake e renderiza por tipo. Specs de marca (dataviz): linhas 2px, barras
// com ponta arredondada só no topo (ancoradas na base), grade recessiva,
// tooltip sempre presente, pizza com vão de 2px e legenda (identidade nunca
// só pela cor), texto em tokens de texto — nunca na cor da série.
// A personalização (WidgetStyle) sobrepõe defaults: cor/paleta, rótulos de
// dado, legenda, formato/decimais, linha de meta e formatação condicional.
import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  LabelList, ReferenceLine,
} from 'recharts'
import { GripVertical, Loader2, Maximize2, Minimize2, Pencil, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import type { Widget, QueryDef, QueryResult, Metric, ConditionalRule } from '@datahub/shared'
import { api } from '@/lib/api'
import { palette, vizTokens, formatValue } from '@/lib/viz'
import { useThemeStore } from '@/store/themeStore'

const VALUE = 'valor' // alias fixo da medida em todos os widgets

function widgetQuery(w: Widget): QueryDef {
  const metricSel = 'metric' in w.metric && typeof (w.metric as { metric?: string }).metric === 'string'
    ? { metric: (w.metric as { metric: string }).metric, as: VALUE }
    : { ...(w.metric as { field: string; agg: never }), as: VALUE }
  if (w.type === 'kpi') {
    return { dataset: w.datasetSlug, select: [metricSel], filters: w.filters, limit: 1 }
  }
  const dim = w.dimension!
  const base: QueryDef = {
    dataset: w.datasetSlug,
    select: [dim, metricSel],
    filters: w.filters,
    groupBy: [dim],
  }
  if (w.type === 'line' || w.type === 'area') {
    return { ...base, orderBy: [{ field: dim, dir: 'asc' }], limit: 500 }
  }
  if (w.type === 'pie') return { ...base, orderBy: [{ field: VALUE, dir: 'desc' }], limit: 8 }
  if (w.type === 'table') return { ...base, orderBy: [{ field: VALUE, dir: 'desc' }], limit: 10 }
  return { ...base, orderBy: [{ field: VALUE, dir: 'desc' }], limit: 20 } // bar
}

// Primeira regra de formatação condicional satisfeita → sua cor (ou undefined).
function condColor(v: number, rules?: ConditionalRule[]): string | undefined {
  if (!rules?.length || Number.isNaN(v)) return undefined
  for (const r of rules) {
    const ok =
      r.op === '>' ? v > r.value :
      r.op === '>=' ? v >= r.value :
      r.op === '<' ? v < r.value :
      r.op === '<=' ? v <= r.value :
      r.op === '=' ? v === r.value : v !== r.value
    if (ok) return r.color
  }
  return undefined
}

interface Props {
  widget: Widget
  metrics: Metric[]
  editable: boolean
  onDelete: () => void
  onResize?: (size: Widget['size']) => void
  onEdit?: () => void
  dragHandleProps?: Record<string, unknown>
  fill?: boolean // preenche a célula do grid (react-grid-layout) em vez de altura fixa
}

export default function WidgetCard({ widget, metrics, editable, onDelete, onResize, onEdit, dragHandleProps, fill }: Props) {
  const theme = useThemeStore((s) => s.theme)
  const style = widget.style ?? {}
  const basePalette = style.palette?.length ? style.palette : palette(theme)
  const primary = style.color || basePalette[0]
  const tokens = vizTokens(theme)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const metricDef = 'metric' in widget.metric
    ? metrics.find((m) => m.slug === (widget.metric as { metric: string }).metric)
    : undefined
  const format = style.numberFormat ?? metricDef?.format ?? 'number'
  const decimals = style.decimals
  const fmt = (v: unknown) => formatValue(v, format, decimals)
  const showLegend = style.showLegend ?? (widget.type === 'pie')
  const showLabels = style.showDataLabels ?? false

  useEffect(() => {
    setResult(null)
    setError(null)
    api<QueryResult>(`/api/v1/datasets/${widget.datasetSlug}/query`, {
      method: 'POST',
      body: JSON.stringify(widgetQuery(widget)),
    })
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha na consulta.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id, widget.datasetSlug])

  const data = useMemo(() => (result?.rows ?? []).map((r) => ({
    ...r,
    [VALUE]: Number(r[VALUE] ?? 0),
    _dim: widget.dimension ? String(r[widget.dimension] ?? '—') : '',
  })), [result, widget.dimension])

  const tooltipStyle = {
    backgroundColor: tokens.surface,
    border: `1px solid ${tokens.grid}`,
    borderRadius: 8,
    fontSize: 12,
    color: tokens.text,
  }
  const axisProps = {
    stroke: tokens.axis, fontSize: 11,
    tickLine: false as const, axisLine: { stroke: tokens.grid },
  }
  const labelProps = { fontSize: 10, fill: tokens.text, formatter: (v: unknown) => fmt(v) }
  const target = typeof style.target === 'number' ? style.target : undefined
  const targetLine = target !== undefined
    ? <ReferenceLine y={target} stroke={tokens.axis} strokeDasharray="4 3" label={{ value: `Meta ${fmt(target)}`, fontSize: 10, fill: tokens.axis, position: 'insideTopRight' }} />
    : null

  function renderChart() {
    if (widget.type === 'kpi') {
      const v = data[0]?.[VALUE]
      const cc = condColor(Number(v), style.conditionalRules)
      return (
        <div className="flex h-full flex-col items-start justify-center px-1">
          <span className="text-3xl font-semibold tabular-nums" style={cc ? { color: cc } : undefined}>{fmt(v)}</span>
        </div>
      )
    }
    if (widget.type === 'table') {
      return (
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-xs">
            <tbody>
              {data.map((r, i) => {
                const cc = condColor(Number(r[VALUE]), style.conditionalRules)
                return (
                  <tr key={i} className="border-t border-zinc-100 first:border-0 dark:border-zinc-800">
                    <td className="max-w-[180px] truncate py-1.5 pr-3">{r._dim}</td>
                    <td className="py-1.5 text-right tabular-nums" style={cc ? { color: cc, fontWeight: 600 } : undefined}>{fmt(r[VALUE])}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )
    }
    if (widget.type === 'pie') {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data} dataKey={VALUE} nameKey="_dim"
              innerRadius="55%" outerRadius="85%"
              stroke={tokens.surface} strokeWidth={2} /* vão de 2px entre fatias */
              label={showLabels ? ({ value }) => fmt(value) : undefined}
            >
              {data.map((_, i) => <Cell key={i} fill={basePalette[i % basePalette.length]} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(v)} />
            {showLegend && <Legend wrapperStyle={{ fontSize: 11, color: tokens.text }} iconSize={9} />}
          </PieChart>
        </ResponsiveContainer>
      )
    }
    if (widget.type === 'line' || widget.type === 'area') {
      const Chart = widget.type === 'line' ? LineChart : AreaChart
      return (
        <ResponsiveContainer width="100%" height="100%">
          <Chart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={tokens.grid} vertical={false} />
            <XAxis dataKey="_dim" {...axisProps} minTickGap={24} />
            <YAxis {...axisProps} width={52} tickFormatter={(v) => fmt(v)} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(v)} />
            {showLegend && <Legend wrapperStyle={{ fontSize: 11, color: tokens.text }} iconSize={9} />}
            {targetLine}
            {widget.type === 'line'
              ? <Line dataKey={VALUE} stroke={primary} strokeWidth={2} dot={false} activeDot={{ r: 4 }} name={widget.title || VALUE}>
                  {showLabels && <LabelList dataKey={VALUE} position="top" {...labelProps} />}
                </Line>
              : <Area dataKey={VALUE} stroke={primary} strokeWidth={2} fill={primary} fillOpacity={0.18} name={widget.title || VALUE}>
                  {showLabels && <LabelList dataKey={VALUE} position="top" {...labelProps} />}
                </Area>}
          </Chart>
        </ResponsiveContainer>
      )
    }
    // bar
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="25%">
          <CartesianGrid stroke={tokens.grid} vertical={false} />
          <XAxis dataKey="_dim" {...axisProps} minTickGap={16} />
          <YAxis {...axisProps} width={52} tickFormatter={(v) => fmt(v)} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(v)} cursor={{ fill: tokens.grid, opacity: 0.35 }} />
          {showLegend && <Legend wrapperStyle={{ fontSize: 11, color: tokens.text }} iconSize={9} />}
          {targetLine}
          <Bar dataKey={VALUE} fill={primary} radius={[4, 4, 0, 0]} name={widget.title || VALUE}>
            {showLabels && <LabelList dataKey={VALUE} position="top" {...labelProps} />}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    )
  }

  const heights: Record<Widget['type'], string> = {
    kpi: 'h-24', table: 'h-56', line: 'h-56', area: 'h-56', bar: 'h-56', pie: 'h-64',
  }

  return (
    <div className={clsx('flex flex-col rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900', fill && 'h-full')}>
      <div className="mb-2 flex items-center gap-1.5">
        {editable && (
          <span
            {...dragHandleProps}
            className={clsx('text-zinc-300 dark:text-zinc-600', fill ? 'widget-drag cursor-grab' : 'cursor-grab')}
            title="Arrastar"
          >
            <GripVertical size={14} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{widget.title || metricDef?.name || 'Widget'}</h3>
          {style.subtitle && <p className="truncate text-[11px] text-zinc-400">{style.subtitle}</p>}
        </div>
        {editable && (
          <span className="flex gap-1">
            {onEdit && (
              <button onClick={onEdit} className="rounded p-1 text-zinc-300 hover:text-accent dark:text-zinc-600" title="Editar widget">
                <Pencil size={13} />
              </button>
            )}
            {!fill && onResize && (
              <button
                onClick={() => onResize(widget.size === 'lg' ? 'md' : 'lg')}
                className="rounded p-1 text-zinc-300 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-300"
                title={widget.size === 'lg' ? 'Diminuir' : 'Ampliar'}
              >
                {widget.size === 'lg' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            )}
            <button onClick={onDelete} className="rounded p-1 text-zinc-300 hover:text-red-500 dark:text-zinc-600" title="Remover widget">
              <Trash2 size={13} />
            </button>
          </span>
        )}
      </div>
      <div className={fill ? 'min-h-0 flex-1' : heights[widget.type]}>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!result && !error && (
          <div className="flex h-full items-center justify-center text-zinc-400"><Loader2 size={16} className="animate-spin" /></div>
        )}
        {result && !error && renderChart()}
      </div>
    </div>
  )
}
