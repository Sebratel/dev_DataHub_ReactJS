// Lista de dashboards do tenant + criação.
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Plus } from 'lucide-react'
import type { DashboardSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { usePrompt } from '@/components/Dialogs'

export default function DashboardsPage() {
  const navigate = useNavigate()
  const prompt = usePrompt()
  const user = useAuthStore((s) => s.user)
  const canCreate = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<{ dashboards: DashboardSummary[] }>('/api/v1/dashboards')
      .then((r) => setDashboards(r.dashboards))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }, [])

  async function create() {
    const name = await prompt({ title: 'Novo dashboard', label: 'Nome do dashboard', placeholder: 'Ex.: Visão da diretoria', confirmLabel: 'Criar' })
    if (!name) return
    try {
      const r = await api<{ id: string }>('/api/v1/dashboards', { method: 'POST', body: JSON.stringify({ name }) })
      navigate(`/dashboards/${r.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao criar.')
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboards</h1>
          <p className="mt-1 text-sm text-zinc-500">Indicadores e gráficos sobre os conjuntos de dados.</p>
        </div>
        {canCreate && (
          <button onClick={create}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover">
            <Plus size={15} /> Novo dashboard
          </button>
        )}
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}
      {dashboards === null && !error && <p className="mt-6 text-sm text-zinc-500">Carregando…</p>}
      {dashboards?.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Nenhum dashboard ainda.{canCreate ? ' Crie o primeiro!' : ''}
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {dashboards?.map((d) => (
          <Link key={d.id} to={`/dashboards/${d.id}`}
            className="group rounded-xl border border-zinc-200 bg-white p-5 transition hover:border-accent hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <LayoutDashboard size={18} className="text-accent" />
            <h2 className="mt-3 font-medium group-hover:text-accent">{d.name}</h2>
            <p className="mt-1 text-xs text-zinc-500">
              {d.widgetCount} widget{d.widgetCount === 1 ? '' : 's'} · {d.ownerEmail.split('@')[0]}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}
