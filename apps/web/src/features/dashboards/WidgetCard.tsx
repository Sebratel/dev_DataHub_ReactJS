// Widget do dashboard: monta o QueryDef a partir da definição salva, consulta
// o lake e renderiza por tipo. Specs de marca (dataviz): linhas 2px, barras
// com ponta arredondada só no topo (ancoradas na base), grade recessiva,
// tooltip sempre presente, pizza com vão de 2px e legenda (identidade nunca
// só pela cor), texto em tokens de texto — nunca na cor da série.
import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { GripVertical, Loader2, Maximize2, Minimize2, Pencil, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import type { Widget, QueryDef, QueryResult, Metric } from '@datahub/shared'
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
  const colors = palette(theme)
  const tokens = vizTokens(theme)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const metricDef = 'metric' in widget.metric
    ? metrics.find((m) => m.slug === (widget.metric as { metric: string }).metric)
    : undefined
  const format = metricDef?.format ?? 'number'

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

  function renderChart() {
    if (widget.type === 'kpi') {
      const v = data[0]?.[VALUE]
      return (
        <div className="flex h-full flex-col items-start justify-center px-1">
          <span className="text-3xl font-semibold tabular-nums">{formatValue(v, format)}</span>
        </div>
      )
    }
    if (widget.type === 'table') {
      return (
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-xs">
            <tbody>
              {data.map((r, i) => (
                <tr key={i} className="border-t border-zinc-100 first:border-0 dark:border-zinc-800">
                  <td className="max-w-[180px] truncate py-1.5 pr-3">{r._dim}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatValue(r[VALUE], format)}</td>
                </tr>
              ))}
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
            >
              {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatValue(v, format)} />
            <Legend wrapperStyle={{ fontSize: 11, color: tokens.text }} iconSize={9} />
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
            <YAxis {...axisProps} width={52} tickFormatter={(v) => formatValue(v, format)} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatValue(v, format)} />
            {widget.type === 'line'
              ? <Line dataKey={VALUE} stroke={colors[0]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} name={widget.title || VALUE} />
              : <Area dataKey={VALUE} stroke={colors[0]} strokeWidth={2} fill={colors[0]} fillOpacity={0.18} name={widget.title || VALUE} />}
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
          <YAxis {...axisProps} width={52} tickFormatter={(v) => formatValue(v, format)} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatValue(v, format)} cursor={{ fill: tokens.grid, opacity: 0.35 }} />
          <Bar dataKey={VALUE} fill={colors[0]} radius={[4, 4, 0, 0]} name={widget.title || VALUE} />
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
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{widget.title || metricDef?.name || 'Widget'}</h3>
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
