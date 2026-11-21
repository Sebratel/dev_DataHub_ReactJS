// Seção "Métricas" dentro do conjunto (item 5 de 19/11/2026): o módulo de
// métricas saiu do menu e a métrica passou a viver junto do conjunto que ela
// mede. Mesma API e mesmo formulário da biblioteca (/metrics), com o conjunto
// já escolhido.
import { useCallback, useEffect, useState } from 'react'
import { Ruler, Plus, Pencil, Trash2, Filter } from 'lucide-react'
import type { Metric } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import { MetricForm, AGG_LABEL, FORMAT_LABEL, filtersSummary, type DatasetOption } from './MetricForm'

export default function DatasetMetrics({ dataset }: { dataset: DatasetOption }) {
  const user = useAuthStore((s) => s.user)
  const confirm = useConfirm()
  const canEdit = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const [metrics, setMetrics] = useState<Metric[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<Metric | 'new' | null>(null)

  const load = useCallback(() => {
    api<{ metrics: Metric[] }>('/api/v1/metrics')
      .then((r) => setMetrics(r.metrics.filter((m) => m.datasetId === dataset.id)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar as métricas.'))
  }, [dataset.id])
  useEffect(load, [load])

  async function remove(m: Metric) {
    if (!(await confirm({
      title: 'Excluir métrica',
      message: `Excluir a métrica "${m.name}"? Widgets que a usam vão quebrar.`,
      danger: true, confirmLabel: 'Excluir',
    }))) return
    try {
      await api(`/api/v1/metrics/${m.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir.')
    }
  }

  return (
    <section id="metricas" className="mt-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
          Métricas {metrics && metrics.length > 0 && <span className="text-zinc-300 dark:text-zinc-600">· {metrics.length}</span>}
        </h2>
        {canEdit && !form && (
          <button onClick={() => setForm('new')}
            className="flex h-7 items-center gap-1 rounded-md border border-zinc-200 px-2 text-[12px] text-zinc-600 transition-colors hover:border-accent hover:text-accent dark:border-zinc-700 dark:text-zinc-300">
            <Plus size={13} /> Nova métrica
          </button>
        )}
      </div>

      {error && <p className="mb-2 text-[12px] text-crit dark:text-crit-dark">{error}</p>}

      {form && (
        <MetricForm
          initial={form === 'new' ? null : form}
          fixedDataset={dataset}
          onClose={() => setForm(null)}
          onSaved={() => { load(); setForm(null) }}
        />
      )}

      {metrics && metrics.length === 0 && !form && (
        <p className="rounded-xl border border-dashed border-zinc-200 px-3 py-3 text-[12px] text-zinc-500 dark:border-zinc-800">
          Nenhuma métrica deste conjunto. Uma métrica (ex.: “Receita contratada” = soma de valor_mensal) é definida uma vez e
          usada nos painéis, nas APIs e pelo assistente.{!canEdit && ' Peça a um editor para criar.'}
        </p>
      )}

      {metrics && metrics.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-card dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-left text-[12px]">
            <thead className="border-b border-zinc-200 text-[10.5px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
              <tr>
                <th className="px-3 py-2 font-medium">Métrica</th>
                <th className="px-3 py-2 font-medium">Cálculo</th>
                <th className="px-3 py-2 font-medium">Formato</th>
                <th className="px-3 py-2 font-medium">Filtros embutidos</th>
                {canEdit && <th className="w-[72px] px-3 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {metrics.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Ruler size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" /> {m.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-zinc-500">
                    <span className="text-zinc-700 dark:text-zinc-300">{AGG_LABEL[m.agg]}</span> de{' '}
                    <span className="font-mono text-[10.5px]">{m.fieldKey}</span>
                  </td>
                  <td className="px-3 py-2 text-zinc-500">{FORMAT_LABEL[m.format]}</td>
                  <td className="px-3 py-2">
                    {m.filters?.length > 0
                      ? <span className="flex items-start gap-1 text-[11px] text-zinc-500">
                          <Filter size={11} className="mt-0.5 shrink-0" />
                          <span className="min-w-0">{filtersSummary(m.filters, (k) => k)}</span>
                        </span>
                      : <span className="text-[11px] text-zinc-400">nenhum</span>}
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2">
                      <span className="flex items-center justify-end gap-0.5">
                        <button onClick={() => setForm(m)} title="Editar métrica"
                          className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => remove(m)} title="Excluir"
                          className="rounded p-1 text-zinc-400 transition-colors hover:bg-crit-soft hover:text-crit dark:hover:bg-crit/15">
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
