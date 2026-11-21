// Biblioteca de Métricas — visão de TODAS as métricas, de todos os conjuntos.
// Desde 21/11/2026 (item 5 de 19/11) ela saiu do menu: o lugar de criar e
// editar a métrica é a seção "Métricas" dentro do próprio conjunto
// (DatasetMetrics). Esta página continua em /metrics para quem tiver o link.
import { useEffect, useState } from 'react'
import { Ruler, Plus, Trash2, Filter, Pencil, Boxes } from 'lucide-react'
import type { Metric, DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { Page, PageHeader, Toolbar, SearchInput, EmptyState, ErrorBanner, TableSkeleton, PrimaryButton } from '@/components/ui/Page'
import KpiBar, { type Kpi } from '@/components/ui/KpiBar'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import { MetricForm, AGG_LABEL, FORMAT_LABEL, filtersSummary } from './MetricForm'

export default function MetricsPage() {
  const user = useAuthStore((s) => s.user)
  const confirm = useConfirm()
  const canEdit = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const [metrics, setMetrics] = useState<Metric[] | null>(null)
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<Metric | 'new' | null>(null)

  function load() {
    api<{ metrics: Metric[] }>('/api/v1/metrics').then((r) => setMetrics(r.metrics))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar métricas.'))
  }
  useEffect(() => {
    load()
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets').then((r) => setDatasets(r.datasets))
      .catch(() => setError('Não foi possível carregar os conjuntos de dados — verifique se a API está no ar.'))
  }, [])

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

  const list = metrics ?? []
  const filtered = list.filter((m) => {
    const q = query.toLowerCase().trim()
    return !q || m.name.toLowerCase().includes(q) || m.datasetName.toLowerCase().includes(q)
      || m.fieldKey.toLowerCase().includes(q)
  })
  const withFilters = list.filter((m) => m.filters?.length > 0).length
  const datasetsUsed = new Set(list.map((m) => m.datasetName)).size

  const kpis: Kpi[] = [
    { label: 'Métricas', icon: Ruler, value: String(list.length), foot: 'definidas uma vez, usadas em tudo' },
    { label: 'Conjuntos cobertos', icon: Boxes, value: String(datasetsUsed), foot: `de ${datasets.length} disponíveis` },
    { label: 'Com filtro embutido', icon: Filter, value: String(withFilters), foot: 'recorte já na definição' },
  ]

  return (
    <Page>
      <PageHeader
        icon={Ruler}
        title="Biblioteca de métricas"
        subtitle="Todas as métricas. Para criar e editar, o caminho é a seção “Métricas” de cada conjunto."
      >
        {canEdit && <PrimaryButton icon={Plus} onClick={() => setForm('new')}>Nova métrica</PrimaryButton>}
      </PageHeader>

      {error && <ErrorBanner message={error} />}

      {form && (
        <MetricForm
          initial={form === 'new' ? null : form}
          datasets={datasets}
          onClose={() => setForm(null)}
          onSaved={() => { load(); setForm(null) }}
        />
      )}

      {metrics === null && !error ? <TableSkeleton /> : (
        <div className="flex flex-col gap-2.5">
          <KpiBar items={kpis} />

          <Toolbar>
            <SearchInput value={query} onChange={setQuery} placeholder="Buscar métrica, conjunto ou campo…" />
          </Toolbar>

          <Card>
            <CardHead icon={Ruler} title="Todas as métricas" sub={`${filtered.length} de ${list.length}`} />
            {filtered.length === 0 ? (
              <EmptyState
                icon={Ruler}
                message={query
                  ? 'Nada encontrado para essa busca.'
                  : `Nenhuma métrica ainda. ${canEdit ? 'Crie a primeira — ela fica disponível nos painéis e para a IA.' : 'Peça a um editor para criar.'}`}
              />
            ) : (
              <DataGrid>
                <thead>
                  <tr>
                    <Th>Métrica</Th>
                    <Th className="w-[170px]">Conjunto</Th>
                    <Th className="w-[190px]">Cálculo</Th>
                    <Th className="w-[104px]">Formato</Th>
                    <Th>Filtros embutidos</Th>
                    {canEdit && <Th className="w-[72px]" />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => (
                    <Tr key={m.id}>
                      <Td>
                        <EntityCell name={m.name}>
                          <Ruler size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                        </EntityCell>
                      </Td>
                      <Td muted>{m.datasetName}</Td>
                      <Td muted>
                        <span className="text-zinc-700 dark:text-zinc-300">{AGG_LABEL[m.agg]}</span>
                        {' de '}
                        <span className="font-mono text-[10.5px]">{m.fieldKey}</span>
                      </Td>
                      <Td muted>{FORMAT_LABEL[m.format]}</Td>
                      <Td>
                        {m.filters?.length > 0
                          ? <span className="flex items-start gap-1 text-[11px] text-zinc-500">
                              <Filter size={11} className="mt-0.5 shrink-0" />
                              <span className="min-w-0">{filtersSummary(m.filters, (k) => k)}</span>
                            </span>
                          : <span className="text-[11px] text-zinc-400">nenhum</span>}
                      </Td>
                      {canEdit && (
                        <Td>
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
                        </Td>
                      )}
                    </Tr>
                  ))}
                </tbody>
              </DataGrid>
            )}
          </Card>
        </div>
      )}
    </Page>
  )
}
