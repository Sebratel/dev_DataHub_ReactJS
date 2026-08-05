// Editor de widget em PAINEL LATERAL (à direita, estilo Power BI / dashboards_IA):
// sem overlay escuro — o dashboard continua visível e o widget editado atualiza
// AO VIVO no grid (via onPreview). Três abas: Dados (tipo de visual + eixos/
// medidas/legenda), Modificadores (Top N + filtro fixo), Formato (aparência).
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  X, Loader2, Plus, Trash2, ChevronDown, Eye,
  Hash, BarChart3, LineChart, AreaChart, PieChart, Table, Type as TypeIcon, Layers, Activity, Filter, Circle,
} from 'lucide-react'
import type {
  DatasetSummary, DatasetDetail, Metric, Widget, WidgetType, Aggregation,
  WidgetStyle, WidgetSpec, MeasureConfig, ConditionalRule, QueryFilter, QueryResult,
} from '@datahub/shared'
import { api } from '@/lib/api'
import { PALETTES, paletteNameOf } from './palettes'
import { buildWidgetQuery } from './widgetQuery'

const VISUALS: { type: WidgetType; label: string; Icon: typeof Hash }[] = [
  { type: 'kpi', label: 'Card (KPI)', Icon: Hash },
  { type: 'bar', label: 'Barras (v)', Icon: BarChart3 },
  { type: 'barH', label: 'Barras (h)', Icon: BarChart3 },
  { type: 'barStacked', label: 'Empilhadas (v)', Icon: Layers },
  { type: 'barHStacked', label: 'Empilhadas (h)', Icon: Layers },
  { type: 'comboBarLine', label: 'Colunas + linha', Icon: Activity },
  { type: 'line', label: 'Linha', Icon: LineChart },
  { type: 'area', label: 'Área', Icon: AreaChart },
  { type: 'pie', label: 'Pizza', Icon: PieChart },
  { type: 'scatter', label: 'Dispersão', Icon: Circle },
  { type: 'funnel', label: 'Funil', Icon: Filter },
  { type: 'table', label: 'Tabela', Icon: Table },
  { type: 'text', label: 'Texto', Icon: TypeIcon },
]
const AGG_LABEL: Record<Aggregation, string> = {
  count: 'Contagem', count_distinct: 'Contagem distinta', sum: 'Soma', avg: 'Média', min: 'Mínimo', max: 'Máximo',
}
const FILTER_OPS: { op: QueryFilter['op']; label: string }[] = [
  { op: '=', label: '=' }, { op: '!=', label: '≠' }, { op: '>', label: '>' }, { op: '<', label: '<' },
  { op: 'contains', label: 'contém' }, { op: 'in', label: 'está em (vírgula)' },
]
const COND_OPS: ConditionalRule['op'][] = ['>', '>=', '<', '<=', '=', '!=']

export type WidgetInput = {
  title: string
  type: WidgetType
  datasetId: string | null
  spec: WidgetSpec | null
  style: WidgetStyle | null
}

interface Props {
  metrics: Metric[]
  initial?: Widget
  onClose: () => void
  onSubmit: (w: WidgetInput) => Promise<void>
  onPreview?: (w: Widget | null) => void
}

type Field = DatasetDetail['fields'][number]

function measureToMetric(m?: MeasureConfig): Widget['metric'] {
  if (m?.metric) return { metric: m.metric }
  if (m?.field && m?.agg) return { field: m.field, agg: m.agg }
  return { field: '', agg: 'count' }
}

// ── Subcomponentes ──────────────────────────────────────────────
function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="border-t border-zinc-200 pt-2 dark:border-zinc-800">
      <button onClick={onToggle} className="flex w-full items-center justify-between py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}<ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-2 grid gap-3 pb-2">{children}</div>}
    </div>
  )
}

const sel = 'w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950'

// Uma medida (agregação + campo + cor).
function MeasureRow({ m, fields, onChange, onRemove }: { m: MeasureConfig; fields: Field[]; onChange: (m: MeasureConfig) => void; onRemove: () => void }) {
  const numeric = fields.filter((f) => f.type === 'number')
  const noField = m.agg === 'count'
  const pool = m.agg === 'count_distinct' ? fields : numeric
  return (
    <div className="flex items-center gap-1.5">
      <select value={m.agg ?? 'count'} onChange={(e) => onChange({ ...m, agg: e.target.value as Aggregation })} className={sel + ' max-w-[130px]'}>
        {(Object.keys(AGG_LABEL) as Aggregation[]).map((a) => <option key={a} value={a}>{AGG_LABEL[a]}</option>)}
      </select>
      {!noField && (
        <select value={m.field ?? ''} onChange={(e) => onChange({ ...m, field: e.target.value })} className={sel}>
          <option value="">— campo —</option>
          {pool.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      )}
      <input type="color" value={m.color || '#2a78d6'} onChange={(e) => onChange({ ...m, color: e.target.value })}
        className="h-8 w-9 shrink-0 cursor-pointer rounded border border-zinc-200 bg-transparent dark:border-zinc-700" title="Cor da série" />
      <button onClick={onRemove} className="shrink-0 rounded p-1 text-zinc-300 hover:text-red-500 dark:text-zinc-600"><Trash2 size={13} /></button>
    </div>
  )
}

// Lista de medidas (Eixo Y) com "Selecionar".
function MeasureWell({ label, hint, measures, fields, onChange }: { label: string; hint?: string; measures: MeasureConfig[]; fields: Field[]; onChange: (m: MeasureConfig[]) => void }) {
  return (
    <div className="text-sm">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
      {hint && <span className="mb-1 block text-[11px] text-zinc-400">{hint}</span>}
      <div className="grid gap-1.5">
        {measures.map((m, i) => (
          <MeasureRow key={i} m={m} fields={fields}
            onChange={(nm) => onChange(measures.map((x, j) => (j === i ? nm : x)))}
            onRemove={() => onChange(measures.filter((_, j) => j !== i))} />
        ))}
        <button onClick={() => onChange([...measures, { agg: 'count' }])}
          className="flex w-fit items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-2.5 py-1 text-xs text-zinc-500 hover:text-accent dark:border-zinc-700">
          <Plus size={12} /> Selecionar
        </button>
      </div>
    </div>
  )
}

// Multiseleção de dimensões (Eixo X): chips + adicionar campo.
function DimWell({ label, hint, dims, fields, onChange }: { label: string; hint?: string; dims: string[]; fields: Field[]; onChange: (d: string[]) => void }) {
  const available = fields.filter((f) => !dims.includes(f.key))
  return (
    <div className="text-sm">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
      {hint && <span className="mb-1 block text-[11px] text-zinc-400">{hint}</span>}
      <div className="flex flex-wrap items-center gap-1.5">
        {dims.map((d) => (
          <span key={d} className="flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
            {fields.find((f) => f.key === d)?.label ?? d}
            <button onClick={() => onChange(dims.filter((x) => x !== d))} className="text-zinc-400 hover:text-red-500"><X size={11} /></button>
          </span>
        ))}
        <select value="" onChange={(e) => { if (e.target.value) onChange([...dims, e.target.value]) }}
          className="rounded-lg border border-dashed border-zinc-300 bg-transparent px-2 py-1 text-xs text-zinc-500 dark:border-zinc-700" disabled={!available.length}>
          <option value="">+ Selecionar</option>
          {available.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>
    </div>
  )
}

export default function WidgetEditorPanel({ metrics, initial, onClose, onSubmit, onPreview }: Props) {
  const isEdit = !!initial
  const sp = initial?.spec ?? {}
  const st = initial?.style ?? {}
  const [tab, setTab] = useState<'data' | 'mods' | 'format'>('data')
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['titulo', 'cor']))
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [datasetId, setDatasetId] = useState(initial?.datasetId ?? '')
  const [type, setType] = useState<WidgetType>(initial?.type ?? 'bar')
  const [title, setTitle] = useState(initial?.title ?? '')
  // Dados (spec)
  const [dimensions, setDimensions] = useState<string[]>(sp.dimensions ?? (initial?.dimension ? [initial.dimension] : []))
  const [measures, setMeasures] = useState<MeasureConfig[]>(() => {
    if (sp.measures) return sp.measures
    const m = initial?.metric as { metric?: string; field?: string; agg?: Aggregation } | undefined
    if (m?.metric) return [{ metric: m.metric }]
    if (m?.field && m?.agg) return [{ field: m.field, agg: m.agg }]
    return []
  })
  const [measuresLine, setMeasuresLine] = useState<MeasureConfig[]>(sp.measuresLine ?? [])
  const [measureX, setMeasureX] = useState<MeasureConfig | null>(sp.measureX ?? null)
  const [legend, setLegend] = useState(sp.legendDimension ?? '')
  const [content, setContent] = useState(sp.content ?? '')
  const [limit, setLimit] = useState<string>(sp.limit != null ? String(sp.limit) : '')
  const [widgetFilters, setWidgetFilters] = useState<QueryFilter[]>(sp.widgetFilters ?? [])
  // Aparência (style)
  const [color, setColor] = useState(st.color ?? '')
  const [paletteName, setPaletteName] = useState(paletteNameOf(st.palette))
  const [showLabels, setShowLabels] = useState(!!st.showDataLabels)
  const [showLegend, setShowLegend] = useState(st.showLegend ?? false)
  const [numberFormat, setNumberFormat] = useState<'auto' | 'number' | 'currency' | 'percent'>(st.numberFormat ?? 'auto')
  const [decimals, setDecimals] = useState<string>(st.decimals != null ? String(st.decimals) : '')
  const [targetV, setTargetV] = useState<string>(st.target != null ? String(st.target) : '')
  const [subtitle, setSubtitle] = useState(st.subtitle ?? '')
  const [rules, setRules] = useState<ConditionalRule[]>(st.conditionalRules ?? [])
  const [preview, setPreview] = useState<Record<string, unknown>[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const skipReset = useRef(isEdit)

  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets').then((r) => setDatasets(r.datasets.filter((d) => d.lastSyncAt))).catch(() => {})
  }, [])

  useEffect(() => {
    const slug = datasets.find((d) => d.id === datasetId)?.slug
    if (!slug) { setFields([]); return }
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${slug}`)
      .then((r) => {
        setFields(r.dataset.fields.filter((f) => !f.hidden && !f.sensitive))
        if (skipReset.current) skipReset.current = false
        else { setDimensions([]); setMeasures([]); setLegend('') }
      }).catch(() => {})
  }, [datasetId, datasets])

  const supportsCond = type === 'kpi' || type === 'table'
  const isText = type === 'text'
  const needsDim = !isText && type !== 'kpi'

  function buildStyle(): WidgetStyle | null {
    const s: WidgetStyle = {}
    if (color) s.color = color
    const pal = PALETTES[paletteName]; if (pal) s.palette = pal
    if (showLabels) s.showDataLabels = true
    s.showLegend = showLegend
    if (numberFormat !== 'auto') s.numberFormat = numberFormat
    if (decimals !== '') s.decimals = Number(decimals)
    if (targetV !== '') s.target = Number(targetV)
    if (subtitle.trim()) s.subtitle = subtitle.trim()
    const vr = rules.filter((r) => r.color && Number.isFinite(r.value))
    if (supportsCond && vr.length) s.conditionalRules = vr
    return Object.keys(s).length ? s : null
  }

  function buildSpec(): WidgetSpec | null {
    const s: WidgetSpec = {}
    if (isText) { if (content.trim()) s.content = content.trim(); return Object.keys(s).length ? s : null }
    if (dimensions.length) s.dimensions = dimensions
    if (measures.length) s.measures = measures
    if (type === 'comboBarLine' && measuresLine.length) s.measuresLine = measuresLine
    if (type === 'scatter' && measureX) s.measureX = measureX
    if (legend) s.legendDimension = legend
    if (limit !== '') s.limit = Number(limit)
    if (widgetFilters.length) s.widgetFilters = widgetFilters
    return Object.keys(s).length ? s : null
  }

  const valid = isText ? content.trim().length > 0
    : !!datasetId && measures.length > 0 && (type === 'kpi' || dimensions.length > 0)

  // Preview ao vivo no grid.
  const previewKey = useMemo(() => JSON.stringify([
    title, type, datasetId, dimensions, measures, measuresLine, measureX, legend, content, limit, widgetFilters,
    color, paletteName, showLabels, showLegend, numberFormat, decimals, targetV, subtitle, rules, datasets.length, valid,
  ]), [title, type, datasetId, dimensions, measures, measuresLine, measureX, legend, content, limit, widgetFilters, color, paletteName, showLabels, showLegend, numberFormat, decimals, targetV, subtitle, rules, datasets.length, valid])

  useEffect(() => {
    if (!onPreview) return
    if (!valid) { onPreview(null); return }
    const dsSlug = datasets.find((d) => d.id === datasetId)?.slug ?? ''
    onPreview({
      id: initial?.id ?? 'preview-new', tabId: initial?.tabId ?? '',
      title: title.trim(), type, datasetId: datasetId || '', datasetSlug: dsSlug,
      dimension: dimensions[0] ?? null, metric: measureToMetric(measures[0]),
      filters: initial?.filters ?? [], size: initial?.size ?? 'md',
      layout: initial?.layout ?? null, style: buildStyle(), spec: buildSpec(),
      sortOrder: initial?.sortOrder ?? 0,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey])
  useEffect(() => () => onPreview?.(null), []) // eslint-disable-line react-hooks/exhaustive-deps

  async function runPreview() {
    const dsSlug = datasets.find((d) => d.id === datasetId)?.slug
    if (!dsSlug || !valid) return
    const w = { type, datasetSlug: dsSlug, dimension: dimensions[0] ?? null, metric: measureToMetric(measures[0]), filters: [], spec: buildSpec() } as unknown as Widget
    const def = buildWidgetQuery(w)
    if (!def) return
    try {
      const r = await api<QueryResult>(`/api/v1/datasets/${dsSlug}/query`, { method: 'POST', body: JSON.stringify({ ...def, limit: 5 }) })
      setPreview(r.rows)
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha no preview.') }
  }

  async function submit() {
    setSaving(true); setError(null)
    try {
      await onSubmit({ title: title.trim(), type, datasetId: isText ? null : (datasetId || null), spec: buildSpec(), style: buildStyle() })
      onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao salvar o widget.'); setSaving(false) }
  }

  const toggle = (k: string) => setOpenSections((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const seg = (a: boolean) => `flex-1 rounded-lg px-2 py-1.5 text-xs font-medium ${a ? 'bg-accent text-zinc-950' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'}`

  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      <div className="pointer-events-auto absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="font-semibold">{isEdit ? 'Editar widget' : 'Novo widget'}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>
        <div className="flex shrink-0 gap-1 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <button onClick={() => setTab('data')} className={seg(tab === 'data')}>Dados</button>
          {!isText && <button onClick={() => setTab('mods')} className={seg(tab === 'mods')}>Modificadores</button>}
          <button onClick={() => setTab('format')} className={seg(tab === 'format')}>Formato</button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {tab === 'data' && (
            <div className="grid gap-3">
              <div>
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-zinc-500">Tipo de visual</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {VISUALS.map(({ type: t, label, Icon }) => (
                    <button key={t} onClick={() => setType(t)}
                      className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-[10px] ${type === t ? 'border-accent bg-accent/10 text-accent' : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-700'}`}>
                      <Icon size={16} /><span className="text-center leading-tight">{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {isText ? (
                <label className="text-sm">
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">Texto</span>
                  <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} className={sel} placeholder="Digite o texto do bloco…" />
                </label>
              ) : (
                <>
                  <label className="text-sm">
                    <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">Conjunto de dados</span>
                    <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} className={sel}>
                      <option value="">— escolha —</option>
                      {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </label>

                  {needsDim && (
                    <DimWell label={type === 'scatter' ? 'Detalhes (pontos)' : 'Eixo X'} hint={type === 'scatter' ? undefined : 'pode adicionar mais de um campo — agrupamento composto'}
                      dims={dimensions} fields={fields} onChange={setDimensions} />
                  )}

                  {type === 'scatter' && (
                    <div className="text-sm">
                      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">Eixo X (numérico)</span>
                      <MeasureRow m={measureX ?? { agg: 'sum' }} fields={fields} onChange={setMeasureX} onRemove={() => setMeasureX(null)} />
                    </div>
                  )}

                  <MeasureWell label={type === 'scatter' ? 'Eixo Y' : 'Eixo Y (medidas)'} hint="cada medida adicionada vira uma série"
                    measures={measures} fields={fields} onChange={setMeasures} />

                  {type === 'comboBarLine' && (
                    <MeasureWell label="Eixo Y — linha" hint="medidas desenhadas como linha" measures={measuresLine} fields={fields} onChange={setMeasuresLine} />
                  )}

                  {needsDim && type !== 'scatter' && type !== 'comboBarLine' && (
                    <label className="text-sm">
                      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">Legenda</span>
                      <span className="mb-1 block text-[11px] text-zinc-400">opcional — cria uma série por valor, até 8</span>
                      <select value={legend} onChange={(e) => setLegend(e.target.value)} className={sel}>
                        <option value="">— sem legenda —</option>
                        {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                    </label>
                  )}

                  <label className="text-sm">
                    <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">Título</span>
                    <input value={title} onChange={(e) => setTitle(e.target.value)} className={sel} placeholder="Ex.: Chamados por cidade" />
                  </label>

                  <button onClick={runPreview} disabled={!valid}
                    className="flex items-center gap-2 rounded-lg border border-accent/50 px-3 py-2 text-sm text-accent hover:bg-accent/10 disabled:opacity-40">
                    <Eye size={15} /> Pré-visualizar dados
                  </button>
                  {preview && (
                    <div className="max-h-40 overflow-auto rounded-lg border border-zinc-200 p-2 text-[11px] dark:border-zinc-800">
                      {preview.length === 0 ? <p className="text-zinc-400">Sem linhas.</p> : preview.map((r, i) => (
                        <div key={i} className="border-b border-zinc-100 py-1 last:border-0 dark:border-zinc-800">
                          {Object.entries(r).map(([k, v]) => <span key={k} className="mr-3 text-zinc-500"><b className="text-zinc-700 dark:text-zinc-300">{k}</b>: {String(v)}</span>)}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'mods' && !isText && (
            <div className="grid gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">Top N (limite)</span>
                <input type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} className={sel} placeholder="ex.: 10 (vazio = padrão)" />
              </label>
              <div className="text-sm">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Filtro fixo do widget</span>
                  <button onClick={() => setWidgetFilters((f) => [...f, { field: fields[0]?.key ?? '', op: '=', value: '' }])}
                    className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:text-accent dark:border-zinc-700"><Plus size={12} /> Filtro</button>
                </div>
                <div className="grid gap-2">
                  {widgetFilters.map((f, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <select value={f.field} onChange={(e) => setWidgetFilters((fs) => fs.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} className={sel + ' max-w-[130px]'}>
                        {fields.map((ff) => <option key={ff.key} value={ff.key}>{ff.label}</option>)}
                      </select>
                      <select value={f.op} onChange={(e) => setWidgetFilters((fs) => fs.map((x, j) => j === i ? { ...x, op: e.target.value as QueryFilter['op'] } : x))} className={sel + ' max-w-[110px]'}>
                        {FILTER_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                      </select>
                      <input value={String(f.value ?? '')} onChange={(e) => setWidgetFilters((fs) => fs.map((x, j) => j === i ? { ...x, value: f.op === 'in' ? e.target.value.split(',').map((s) => s.trim()) : e.target.value } : x))} className={sel} placeholder="valor" />
                      <button onClick={() => setWidgetFilters((fs) => fs.filter((_, j) => j !== i))} className="shrink-0 rounded p-1 text-zinc-300 hover:text-red-500 dark:text-zinc-600"><Trash2 size={13} /></button>
                    </div>
                  ))}
                  {widgetFilters.length === 0 && <p className="text-xs text-zinc-400">Sem filtro fixo.</p>}
                </div>
              </div>
            </div>
          )}

          {tab === 'format' && (
            <div className="grid gap-1">
              <Section title="Título e subtítulo" open={openSections.has('titulo')} onToggle={() => toggle('titulo')}>
                <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Título</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} className={sel} /></label>
                <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Subtítulo</span>
                  <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} className={sel} placeholder="opcional" /></label>
              </Section>
              {!isText && (
                <Section title="Cor e paleta" open={openSections.has('cor')} onToggle={() => toggle('cor')}>
                  <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Paleta (séries/pizza)</span>
                    <select value={paletteName} onChange={(e) => setPaletteName(e.target.value)} className={sel}>
                      {Object.keys(PALETTES).map((n) => <option key={n} value={n}>{n}</option>)}
                    </select></label>
                  <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Cor primária (série única)</span>
                    <div className="flex items-center gap-2">
                      <input type="color" value={color || '#2a78d6'} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-zinc-200 bg-transparent dark:border-zinc-700" />
                      {color && <button onClick={() => setColor('')} className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">usar padrão</button>}
                    </div></label>
                </Section>
              )}
              {!isText && (
                <Section title="Formato do número" open={openSections.has('formato')} onToggle={() => toggle('formato')}>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <label><span className="mb-1 block text-xs text-zinc-500">Formato</span>
                      <select value={numberFormat} onChange={(e) => setNumberFormat(e.target.value as typeof numberFormat)} className={sel}>
                        <option value="auto">Automático</option><option value="number">Número</option><option value="currency">Moeda (R$)</option><option value="percent">Percentual</option>
                      </select></label>
                    <label><span className="mb-1 block text-xs text-zinc-500">Casas decimais</span>
                      <input type="number" min={0} max={6} value={decimals} onChange={(e) => setDecimals(e.target.value)} className={sel} placeholder="auto" /></label>
                  </div>
                </Section>
              )}
              {needsDim && (
                <Section title="Rótulos, legenda e meta" open={openSections.has('grafico')} onToggle={() => toggle('grafico')}>
                  {type !== 'table' && (
                    <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Linha de meta (opcional)</span>
                      <input type="number" value={targetV} onChange={(e) => setTargetV(e.target.value)} className={sel} placeholder="ex.: 1000" /></label>
                  )}
                  <div className="flex flex-wrap gap-3 text-sm">
                    <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Rótulos de dados</label>
                    <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={showLegend} onChange={(e) => setShowLegend(e.target.checked)} /> Legenda</label>
                  </div>
                </Section>
              )}
              {supportsCond && (
                <Section title="Formatação condicional" open={openSections.has('cond')} onToggle={() => toggle('cond')}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs text-zinc-500">Pinta o valor conforme a regra</span>
                    <button onClick={() => setRules((r) => [...r, { op: '>', value: 0, color: '#e34948' }])} className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:text-accent dark:border-zinc-700"><Plus size={12} /> Regra</button>
                  </div>
                  <div className="grid gap-2">
                    {rules.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <select value={r.op} onChange={(e) => setRules((rs) => rs.map((x, j) => j === i ? { ...x, op: e.target.value as ConditionalRule['op'] } : x))} className={sel + ' max-w-[70px]'}>
                          {COND_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                        </select>
                        <input type="number" value={r.value} onChange={(e) => setRules((rs) => rs.map((x, j) => j === i ? { ...x, value: Number(e.target.value) } : x))} className={sel + ' max-w-[90px]'} />
                        <input type="color" value={r.color} onChange={(e) => setRules((rs) => rs.map((x, j) => j === i ? { ...x, color: e.target.value } : x))} className="h-8 w-10 cursor-pointer rounded border border-zinc-200 bg-transparent dark:border-zinc-700" />
                        <button onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} className="rounded p-1 text-zinc-300 hover:text-red-500 dark:text-zinc-600"><Trash2 size={13} /></button>
                      </div>
                    ))}
                    {rules.length === 0 && <p className="text-xs text-zinc-400">Nenhuma regra.</p>}
                  </div>
                </Section>
              )}
            </div>
          )}
          {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">Cancelar</button>
          <button onClick={submit} disabled={!valid || saving}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Salvar' : 'Adicionar'}
          </button>
        </div>
      </div>
    </div>
  )
}
