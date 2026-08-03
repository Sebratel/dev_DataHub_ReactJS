// Editor de widget em PAINEL LATERAL (à direita, estilo Power BI / dashboards_IA):
// sem overlay escuro — o dashboard continua visível e o widget editado atualiza
// AO VIVO no grid (via onPreview). Abas Dados | Aparência; a Aparência é dividida
// em seções recolhíveis. Persiste só ao salvar.
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, Plus, Trash2, ChevronDown } from 'lucide-react'
import type {
  DatasetSummary, DatasetDetail, Metric, Widget, WidgetType, Aggregation, WidgetStyle, ConditionalRule,
} from '@datahub/shared'
import { api } from '@/lib/api'
import { PALETTES, paletteNameOf } from './palettes'

const TYPE_LABEL: Record<WidgetType, string> = {
  kpi: 'KPI (número)', line: 'Linha', bar: 'Barras', pie: 'Pizza', area: 'Área', table: 'Tabela',
}
const AGG_LABEL: Record<string, string> = {
  count: 'Contagem', count_distinct: 'Contagem distinta', sum: 'Soma', avg: 'Média', min: 'Mínimo', max: 'Máximo',
}
const COND_OPS: ConditionalRule['op'][] = ['>', '>=', '<', '<=', '=', '!=']

export type WidgetInput = {
  title: string; type: WidgetType; datasetId: string; dimension: string | null
  metric: { metric: string } | { field: string; agg: Aggregation }
  style?: WidgetStyle | null
}

interface Props {
  metrics: Metric[]
  initial?: Widget // presente = edição
  onClose: () => void
  onSubmit: (w: WidgetInput) => Promise<void>
  onPreview?: (w: Widget | null) => void // preview ao vivo no grid
}

// Seção recolhível (acordeão) da aba Aparência.
function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="border-t border-zinc-200 pt-2 dark:border-zinc-800">
      <button onClick={onToggle} className="flex w-full items-center justify-between py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-2 grid gap-3 pb-2">{children}</div>}
    </div>
  )
}

export default function WidgetEditorPanel({ metrics, initial, onClose, onSubmit, onPreview }: Props) {
  const isEdit = !!initial
  const initLib = !!initial && 'metric' in initial.metric
  const st = initial?.style ?? {}
  const [section, setSection] = useState<'data' | 'style'>('data')
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['titulo', 'cor']))
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [fields, setFields] = useState<DatasetDetail['fields']>([])
  const [datasetId, setDatasetId] = useState(initial?.datasetId ?? '')
  const [type, setType] = useState<WidgetType>(initial?.type ?? 'bar')
  const [dimension, setDimension] = useState(initial?.dimension ?? '')
  const [metricMode, setMetricMode] = useState<'library' | 'adhoc'>(initLib ? 'library' : 'adhoc')
  const [metricSlug, setMetricSlug] = useState(initLib ? (initial!.metric as { metric: string }).metric : '')
  const [agg, setAgg] = useState<Aggregation>(!initLib && initial ? (initial.metric as { agg: Aggregation }).agg : 'count')
  const [field, setField] = useState(!initLib && initial ? (initial.metric as { field: string }).field : '')
  const [title, setTitle] = useState(initial?.title ?? '')
  // Aparência
  const [color, setColor] = useState(st.color ?? '')
  const [paletteName, setPaletteName] = useState(paletteNameOf(st.palette))
  const [showLabels, setShowLabels] = useState(!!st.showDataLabels)
  const [showLegend, setShowLegend] = useState(st.showLegend ?? (type === 'pie'))
  const [numberFormat, setNumberFormat] = useState<'auto' | 'number' | 'currency' | 'percent'>(st.numberFormat ?? 'auto')
  const [decimals, setDecimals] = useState<string>(st.decimals != null ? String(st.decimals) : '')
  const [target, setTarget] = useState<string>(st.target != null ? String(st.target) : '')
  const [subtitle, setSubtitle] = useState(st.subtitle ?? '')
  const [rules, setRules] = useState<ConditionalRule[]>(st.conditionalRules ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const skipReset = useRef(isEdit)

  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets.filter((d) => d.lastSyncAt)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const slug = datasets.find((d) => d.id === datasetId)?.slug
    if (!slug) { setFields([]); return }
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${slug}`)
      .then((r) => {
        setFields(r.dataset.fields.filter((f) => !f.hidden && !f.sensitive))
        if (skipReset.current) skipReset.current = false
        else { setDimension(''); setField(''); setMetricSlug('') }
      })
      .catch(() => {})
  }, [datasetId, datasets])

  const datasetMetrics = metrics.filter((m) => m.datasetId === datasetId)
  const supportsCond = type === 'kpi' || type === 'table'

  function buildStyle(): WidgetStyle | null {
    const s: WidgetStyle = {}
    if (color) s.color = color
    const pal = PALETTES[paletteName]
    if (pal) s.palette = pal
    if (showLabels) s.showDataLabels = true
    s.showLegend = showLegend
    if (numberFormat !== 'auto') s.numberFormat = numberFormat
    if (decimals !== '') s.decimals = Number(decimals)
    if (target !== '') s.target = Number(target)
    if (subtitle.trim()) s.subtitle = subtitle.trim()
    const validRules = rules.filter((r) => r.color && Number.isFinite(r.value))
    if (supportsCond && validRules.length) s.conditionalRules = validRules
    return Object.keys(s).length ? s : null
  }

  const valid = !!datasetId && (type === 'kpi' || !!dimension) &&
    (metricMode === 'library' ? !!metricSlug : !!field)

  // Preview ao vivo: reconstrói o widget do rascunho e devolve ao DashboardPage.
  const previewKey = useMemo(() => JSON.stringify([
    title, type, datasetId, dimension, metricMode, metricSlug, agg, field,
    color, paletteName, showLabels, showLegend, numberFormat, decimals, target, subtitle, rules,
    datasets.length, valid,
  ]), [title, type, datasetId, dimension, metricMode, metricSlug, agg, field, color, paletteName, showLabels, showLegend, numberFormat, decimals, target, subtitle, rules, datasets.length, valid])

  useEffect(() => {
    if (!onPreview) return
    if (!valid) { onPreview(null); return }
    const dsSlug = datasets.find((d) => d.id === datasetId)?.slug
    if (!dsSlug) { onPreview(null); return }
    onPreview({
      id: initial?.id ?? 'preview-new',
      tabId: initial?.tabId ?? '',
      title: title.trim(), type,
      datasetId, datasetSlug: dsSlug,
      dimension: type === 'kpi' ? null : dimension,
      metric: metricMode === 'library' ? { metric: metricSlug } : { field, agg },
      filters: initial?.filters ?? [],
      size: initial?.size ?? 'md',
      layout: initial?.layout ?? null,
      style: buildStyle(),
      sortOrder: initial?.sortOrder ?? 0,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey])

  // Ao fechar, some com o preview.
  useEffect(() => () => onPreview?.(null), []) // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    setSaving(true)
    setError(null)
    try {
      await onSubmit({
        title: title.trim(), type, datasetId,
        dimension: type === 'kpi' ? null : dimension,
        metric: metricMode === 'library' ? { metric: metricSlug } : { field, agg },
        style: buildStyle(),
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar o widget.')
      setSaving(false)
    }
  }

  const toggle = (k: string) => setOpenSections((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const sel = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950'
  const seg = (active: boolean) =>
    `flex-1 rounded-lg px-3 py-1.5 text-xs font-medium ${active ? 'bg-accent text-zinc-950' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'}`

  return (
    // Sem overlay escuro: o wrapper deixa os cliques passarem para o dashboard;
    // só o painel captura eventos (o grid atrás continua visível/interativo).
    <div className="pointer-events-none fixed inset-0 z-40">
      <div className="pointer-events-auto absolute right-0 top-0 flex h-full w-full max-w-[420px] flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="font-semibold">{isEdit ? 'Editar widget' : 'Novo widget'}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={18} /></button>
        </div>
        <div className="flex shrink-0 gap-1 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <button onClick={() => setSection('data')} className={seg(section === 'data')}>Dados</button>
          <button onClick={() => setSection('style')} className={seg(section === 'style')}>Aparência</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {section === 'data' ? (
            <div className="grid gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">Conjunto de dados (já sincronizado)</span>
                <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} className={sel}>
                  <option value="">— escolha —</option>
                  {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">Tipo</span>
                <select value={type} onChange={(e) => setType(e.target.value as WidgetType)} className={sel}>
                  {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              {type !== 'kpi' && (
                <label className="text-sm">
                  <span className="mb-1 block text-xs text-zinc-500">Dimensão (eixo/categoria)</span>
                  <select value={dimension} onChange={(e) => setDimension(e.target.value)} className={sel} disabled={!fields.length}>
                    <option value="">— escolha —</option>
                    {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </label>
              )}
              <div className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">Medida</span>
                <div className="mb-2 flex gap-2 text-xs">
                  <button onClick={() => setMetricMode('adhoc')}
                    className={`rounded-full px-2.5 py-1 ${metricMode === 'adhoc' ? 'bg-accent text-zinc-950' : 'border border-zinc-200 dark:border-zinc-700'}`}>
                    Agregação simples
                  </button>
                  <button onClick={() => setMetricMode('library')} disabled={!datasetMetrics.length}
                    className={`rounded-full px-2.5 py-1 disabled:opacity-40 ${metricMode === 'library' ? 'bg-accent text-zinc-950' : 'border border-zinc-200 dark:border-zinc-700'}`}>
                    Métrica da biblioteca {datasetMetrics.length ? `(${datasetMetrics.length})` : ''}
                  </button>
                </div>
                {metricMode === 'library' ? (
                  <select value={metricSlug} onChange={(e) => setMetricSlug(e.target.value)} className={sel}>
                    <option value="">— escolha a métrica —</option>
                    {datasetMetrics.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
                  </select>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <select value={agg} onChange={(e) => setAgg(e.target.value as Aggregation)} className={sel}>
                      {Object.entries(AGG_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <select value={field} onChange={(e) => setField(e.target.value)} className={sel} disabled={!fields.length}>
                      <option value="">— campo —</option>
                      {fields.filter((f) => ['count', 'count_distinct'].includes(agg) || f.type === 'number')
                        .map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </div>
                )}
              </div>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">Título</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} className={sel} placeholder="Ex.: Chamados por cidade" />
              </label>
            </div>
          ) : (
            <div className="grid gap-1">
              <Section title="Título e subtítulo" open={openSections.has('titulo')} onToggle={() => toggle('titulo')}>
                <label className="text-sm">
                  <span className="mb-1 block text-xs text-zinc-500">Título</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} className={sel} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-xs text-zinc-500">Subtítulo (opcional)</span>
                  <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} className={sel} placeholder="Ex.: últimos 30 dias" />
                </label>
              </Section>

              <Section title="Cor e paleta" open={openSections.has('cor')} onToggle={() => toggle('cor')}>
                {type === 'pie' ? (
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-zinc-500">Paleta</span>
                    <select value={paletteName} onChange={(e) => setPaletteName(e.target.value)} className={sel}>
                      {Object.keys(PALETTES).map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                ) : type !== 'table' && (
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-zinc-500">Cor primária</span>
                    <div className="flex items-center gap-2">
                      <input type="color" value={color || '#2a78d6'} onChange={(e) => setColor(e.target.value)}
                        className="h-9 w-12 cursor-pointer rounded border border-zinc-200 bg-transparent dark:border-zinc-700" />
                      {color && <button onClick={() => setColor('')} className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">usar padrão</button>}
                    </div>
                  </label>
                )}
              </Section>

              <Section title="Formato do número" open={openSections.has('formato')} onToggle={() => toggle('formato')}>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-zinc-500">Formato</span>
                    <select value={numberFormat} onChange={(e) => setNumberFormat(e.target.value as typeof numberFormat)} className={sel}>
                      <option value="auto">Automático</option>
                      <option value="number">Número</option>
                      <option value="currency">Moeda (R$)</option>
                      <option value="percent">Percentual</option>
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-xs text-zinc-500">Casas decimais</span>
                    <input type="number" min={0} max={6} value={decimals} onChange={(e) => setDecimals(e.target.value)} className={sel} placeholder="auto" />
                  </label>
                </div>
              </Section>

              {type !== 'kpi' && (
                <Section title="Eixos, rótulos e meta" open={openSections.has('grafico')} onToggle={() => toggle('grafico')}>
                  {type !== 'table' && (
                    <label className="text-sm">
                      <span className="mb-1 block text-xs text-zinc-500">Linha de meta (opcional)</span>
                      <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} className={sel} placeholder="ex.: 1000" />
                    </label>
                  )}
                  <div className="flex flex-wrap gap-4 text-sm">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
                      Rótulos de dados
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={showLegend} onChange={(e) => setShowLegend(e.target.checked)} />
                      Legenda
                    </label>
                  </div>
                </Section>
              )}

              {supportsCond && (
                <Section title="Formatação condicional" open={openSections.has('cond')} onToggle={() => toggle('cond')}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs text-zinc-500">Pinta o valor conforme a regra</span>
                    <button
                      onClick={() => setRules((r) => [...r, { op: '>', value: 0, color: '#e34948' }])}
                      className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:text-accent dark:border-zinc-700">
                      <Plus size={12} /> Regra
                    </button>
                  </div>
                  <div className="grid gap-2">
                    {rules.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <select value={r.op} onChange={(e) => setRules((rs) => rs.map((x, j) => j === i ? { ...x, op: e.target.value as ConditionalRule['op'] } : x))}
                          className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                          {COND_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                        </select>
                        <input type="number" value={r.value}
                          onChange={(e) => setRules((rs) => rs.map((x, j) => j === i ? { ...x, value: Number(e.target.value) } : x))}
                          className="w-20 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
                        <input type="color" value={r.color}
                          onChange={(e) => setRules((rs) => rs.map((x, j) => j === i ? { ...x, color: e.target.value } : x))}
                          className="h-8 w-10 cursor-pointer rounded border border-zinc-200 bg-transparent dark:border-zinc-700" />
                        <button onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                          className="rounded p-1 text-zinc-300 hover:text-red-500 dark:text-zinc-600"><Trash2 size={13} /></button>
                      </div>
                    ))}
                    {rules.length === 0 && <p className="text-xs text-zinc-400">Nenhuma regra — o valor usa a cor padrão.</p>}
                  </div>
                </Section>
              )}
            </div>
          )}
          {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            Cancelar
          </button>
          <button onClick={submit} disabled={!valid || saving}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Salvar' : 'Adicionar'}
          </button>
        </div>
      </div>
    </div>
  )
}
