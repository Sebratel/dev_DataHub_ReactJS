// Home: dashboards recentes, conjuntos de dados e atalhos.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Boxes, LayoutDashboard, Ruler, Sparkles, ArrowRight } from 'lucide-react'
import type { DashboardSummary, DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'

export default function HomePage() {
  const user = useAuthStore((s) => s.user)
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([])
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])

  useEffect(() => {
    api<{ dashboards: DashboardSummary[] }>('/api/v1/dashboards').then((r) => setDashboards(r.dashboards)).catch(() => {})
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets').then((r) => setDatasets(r.datasets)).catch(() => {})
  }, [])

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Olá, {user?.name.split(' ')[0]} 👋</h1>
      <p className="mt-1 text-sm text-zinc-500">O que você quer analisar hoje?</p>

      {/* Dashboards recentes */}
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Dashboards recentes</h2>
        <Link to="/dashboards" className="flex items-center gap-1 text-xs text-accent hover:underline">
          ver todos <ArrowRight size={12} />
        </Link>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {dashboards.slice(0, 3).map((d) => (
          <Link key={d.id} to={`/dashboards/${d.id}`}
            className="group rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-accent dark:border-zinc-800 dark:bg-zinc-900">
            <LayoutDashboard size={16} className="text-accent" />
            <p className="mt-2 truncate text-sm font-medium group-hover:text-accent">{d.name}</p>
            <p className="text-xs text-zinc-500">{d.widgetCount} widgets</p>
          </Link>
        ))}
        {dashboards.length === 0 && (
          <p className="col-span-3 rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Nenhum dashboard ainda — <Link to="/dashboards" className="text-accent hover:underline">crie o primeiro</Link>.
          </p>
        )}
      </div>

      {/* Conjuntos de dados */}
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">Conjuntos de dados</h2>
        <Link to="/datasets" className="flex items-center gap-1 text-xs text-accent hover:underline">
          ver catálogo <ArrowRight size={12} />
        </Link>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {datasets.slice(0, 6).map((d) => (
          <Link key={d.id} to={`/datasets/${d.slug}`}
            className="group rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-accent dark:border-zinc-800 dark:bg-zinc-900">
            <Boxes size={16} className="text-accent" />
            <p className="mt-2 truncate text-sm font-medium group-hover:text-accent">{d.name}</p>
            <p className="text-xs text-zinc-500">
              {d.rowCount !== null ? `${d.rowCount.toLocaleString('pt-BR')} registros` : `${d.fieldCount} campos`}
            </p>
          </Link>
        ))}
      </div>

      {/* Atalhos */}
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <Link to="/metrics" className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-accent dark:border-zinc-800 dark:bg-zinc-900">
          <Ruler size={18} className="text-accent" />
          <span>
            <p className="text-sm font-medium">Biblioteca de Métricas</p>
            <p className="text-xs text-zinc-500">Receita, chamados, clientes ativos — definidos uma vez, usados em tudo.</p>
          </span>
        </Link>
        <Link to="/ai" className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-accent dark:border-zinc-800 dark:bg-zinc-900">
          <Sparkles size={18} className="text-accent" />
          <span>
            <p className="text-sm font-medium">Assistente IA</p>
            <p className="text-xs text-zinc-500">Pergunte em linguagem natural sobre os seus dados.</p>
          </span>
        </Link>
      </div>
    </div>
  )
}
