// Modal de widget — NOVO ou EDITAR: dataset → tipo → dimensão → métrica (da
// biblioteca ou ad-hoc: agregação + campo). Ao receber `initial`, pré-preenche
// os campos e o botão passa a salvar a edição.
import { useEffect, useRef, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import type { DatasetSummary, DatasetDetail, Metric, Widget, WidgetType, Aggregation } from '@datahub/shared'
import { api } from '@/lib/api'

const TYPE_LABEL: Record<WidgetType, string> = {
  kpi: 'KPI (número)', line: 'Linha', bar: 'Barras', pie: 'Pizza', area: 'Área', table: 'Tabela',
}
const AGG_LABEL: Record<string, string> = {
  count: 'Contagem', count_distinct: 'Contagem distinta', sum: 'Soma', avg: 'Média', min: 'Mínimo', max: 'Máximo',
}

type WidgetInput = {
  title: string; type: WidgetType; datasetId: string; dimension: string | null
  metric: { metric: string } | { field: string; agg: Aggregation }
}

interface Props {
  metrics: Metric[]
  initial?: Widget // presente = modo edição
  onClose: () => void
  onSubmit: (w: WidgetInput) => Promise<void>
}

export default function AddWidgetModal({ metrics, initial, onClose, onSubmit }: Props) {
  const isEdit = !!initial
  const initLib = !!initial && 'metric' in initial.metric
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // No modo edição, preserva dimensão/campo no PRIMEIRO carregamento do dataset
  // inicial (o carregamento de campos, por padrão, os limparia).
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
        if (skipReset.current) skipReset.current = false // preserva valores iniciais
        else { setDimension(''); setField(''); setMetricSlug('') }
      })
      .catch(() => {})
  }, [datasetId, datasets])

  const datasetMetrics = metrics.filter((m) => m.datasetId === datasetId)

  async function submit() {
    setSaving(true)
    setError(null)
    try {
      await onSubmit({
        title: title.trim(),
        type,
        datasetId,
        dimension: type === 'kpi' ? null : dimension,
        metric: metricMode === 'library' ? { metric: metricSlug } : { field, agg },
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar o widget.')
      setSaving(false)
    }
  }

  const valid = datasetId && (type === 'kpi' || dimension) &&
    (metricMode === 'library' ? metricSlug : field)

  const sel = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950'

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{isEdit ? 'Editar widget' : 'Novo widget'}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
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
            <span className="mb-1 block text-xs text-zinc-500">Título (opcional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={sel} placeholder="Ex.: Chamados por cidade" />
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={submit} disabled={!valid || saving}
            className="mt-1 flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Salvar alterações' : 'Adicionar ao dashboard'}
          </button>
        </div>
      </div>
    </div>
  )
}
