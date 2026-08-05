// Lista de painéis do tenant + criação. Mesma lógica das outras telas: barra de
// métricas, busca, tabela densa.
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Plus, Grid3x3, Users } from 'lucide-react'
import type { DashboardSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { usePrompt } from '@/components/Dialogs'
import { Page, PageHeader, Toolbar, SearchInput, EmptyState, ErrorBanner, TableSkeleton, PrimaryButton } from '@/components/ui/Page'
import KpiBar, { type Kpi } from '@/components/ui/KpiBar'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}

export default function DashboardsPage() {
  const navigate = useNavigate()
  const prompt = usePrompt()
  const user = useAuthStore((s) => s.user)
  const canCreate = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    api<{ dashboards: DashboardSummary[] }>('/api/v1/dashboards')
      .then((r) => setDashboards(r.dashboards))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }, [])

  async function create() {
    const name = await prompt({
      title: 'Novo painel', label: 'Nome do painel',
      placeholder: 'Ex.: Visão da diretoria', confirmLabel: 'Criar',
    })
    if (!name) return
    try {
      const r = await api<{ id: string }>('/api/v1/dashboards', { method: 'POST', body: JSON.stringify({ name }) })
      navigate(`/dashboards/${r.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao criar.')
    }
  }

  const list = dashboards ?? []
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    return list.filter((d) => !q || d.name.toLowerCase().includes(q) || d.ownerEmail.toLowerCase().includes(q))
  }, [list, query])

  const widgets = list.reduce((s, d) => s + d.widgetCount, 0)
  const owners = new Set(list.map((d) => d.ownerEmail)).size
  const empty = list.filter((d) => d.widgetCount === 0).length

  const kpis: Kpi[] = [
    { label: 'Painéis', icon: LayoutDashboard, value: String(list.length), foot: empty ? `${empty} sem widget` : 'todos com conteúdo' },
    { label: 'Widgets', icon: Grid3x3, value: String(widgets), foot: list.length ? `${(widgets / list.length).toFixed(1)} por painel` : '—' },
    { label: 'Autores', icon: Users, value: String(owners), foot: 'pessoas que publicaram' },
  ]

  return (
    <Page>
      <PageHeader
        icon={LayoutDashboard}
        title="Painéis"
        subtitle="Indicadores e gráficos sobre os conjuntos do lake."
      >
        {canCreate && <PrimaryButton icon={Plus} onClick={create}>Novo painel</PrimaryButton>}
      </PageHeader>

      {error && <ErrorBanner message={error} />}

      {dashboards === null && !error ? <TableSkeleton /> : (
        <div className="flex flex-col gap-2.5">
          <KpiBar items={kpis} />

          <Toolbar>
            <SearchInput value={query} onChange={setQuery} placeholder="Buscar painel ou autor…" />
          </Toolbar>

          <Card>
            <CardHead icon={LayoutDashboard} title="Todos os painéis" sub={`${filtered.length} de ${list.length}`} />
            {filtered.length === 0 ? (
              <EmptyState
                icon={LayoutDashboard}
                message={query
                  ? 'Nada encontrado para essa busca.'
                  : `Nenhum painel ainda.${canCreate ? ' Crie o primeiro a partir das métricas dos seus conjuntos.' : ''}`}
                action={canCreate && !query ? (
                  <button onClick={create} className="text-[12px] font-medium text-info hover:underline dark:text-info-dark">
                    Criar painel
                  </button>
                ) : undefined}
              />
            ) : (
              <DataGrid>
                <thead>
                  <tr>
                    <Th>Painel</Th>
                    <Th right className="w-[88px]">Widgets</Th>
                    <Th className="w-[180px]">Autor</Th>
                    <Th className="w-[104px]">Atualizado</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <Tr key={d.id}>
                      <Td>
                        <Link to={`/dashboards/${d.id}`} className="block hover:text-info dark:hover:text-info-dark">
                          <EntityCell name={d.name}>
                            <LayoutDashboard size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                          </EntityCell>
                        </Link>
                      </Td>
                      <Td right muted>{d.widgetCount}</Td>
                      <Td muted>{d.ownerEmail === user?.email ? 'você' : d.ownerEmail.split('@')[0]}</Td>
                      <Td muted>{timeAgo((d as { updatedAt?: string }).updatedAt)}</Td>
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
