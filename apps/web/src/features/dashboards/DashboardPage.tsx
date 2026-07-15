// Página de um dashboard: grade de widgets com reordenação por arrastar
// (HTML5 drag), redimensionar, adicionar e remover.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2, Share2 } from 'lucide-react'
import clsx from 'clsx'
import type { DashboardDetail, Metric, Widget } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import WidgetCard from './WidgetCard'
import AddWidgetModal from './AddWidgetModal'
import ShareDialog from './ShareDialog'

export default function DashboardPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const [dash, setDash] = useState<DashboardDetail | null>(null)
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const dragFrom = useRef<number | null>(null)

  const load = useCallback(() => {
    api<{ dashboard: DashboardDetail }>(`/api/v1/dashboards/${id}`)
      .then((r) => setDash(r.dashboard))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }, [id])

  useEffect(() => {
    load()
    api<{ metrics: Metric[] }>('/api/v1/metrics').then((r) => setMetrics(r.metrics)).catch(() => {})
  }, [load])

  const editable = !!user && (user.roles.includes('admin') ||
    (user.roles.includes('editor') && dash?.ownerEmail === user.email) || dash?.ownerEmail === user.email)

  async function addWidget(w: Parameters<Parameters<typeof AddWidgetModal>[0]['onCreate']>[0]) {
    await api(`/api/v1/dashboards/${id}/widgets`, { method: 'POST', body: JSON.stringify(w) })
    load()
  }

  async function deleteWidget(widgetId: string) {
    await api(`/api/v1/dashboards/${id}/widgets/${widgetId}`, { method: 'DELETE' })
    load()
  }

  async function resizeWidget(widgetId: string, size: Widget['size']) {
    await api(`/api/v1/dashboards/${id}/widgets/${widgetId}`, { method: 'PATCH', body: JSON.stringify({ size }) })
    load()
  }

  // Reordenação por arrastar: solta sobre outro widget → troca as posições.
  async function reorder(from: number, to: number) {
    if (!dash || from === to) return
    const list = [...dash.widgets]
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    setDash({ ...dash, widgets: list }) // otimista
    await Promise.all(list.map((w, i) =>
      api(`/api/v1/dashboards/${id}/widgets/${w.id}`, { method: 'PATCH', body: JSON.stringify({ sortOrder: i }) })))
  }

  async function deleteDashboard() {
    if (!window.confirm(`Excluir o dashboard "${dash?.name}"?`)) return
    await api(`/api/v1/dashboards/${id}`, { method: 'DELETE' })
    navigate('/dashboards')
  }

  if (error) return <p className="rounded-lg bg-red-50 p-4 text-sm text-red-600 dark:bg-red-950/40">{error}</p>
  if (!dash) return <p className="text-sm text-zinc-500">Carregando…</p>

  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/dashboards" className="mb-3 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-accent">
        <ArrowLeft size={14} /> Dashboards
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{dash.name}</h1>
          {dash.description && <p className="mt-1 text-sm text-zinc-500">{dash.description}</p>}
        </div>
        {editable && (
          <div className="flex shrink-0 gap-2">
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover">
              <Plus size={15} /> Widget
            </button>
            <button onClick={() => setShowShare(true)} title="Compartilhar"
              className="rounded-lg border border-zinc-200 p-2 text-zinc-400 hover:text-accent dark:border-zinc-700">
              <Share2 size={15} />
            </button>
            <button onClick={deleteDashboard} title="Excluir dashboard"
              className="rounded-lg border border-zinc-200 p-2 text-zinc-400 hover:text-red-500 dark:border-zinc-700">
              <Trash2 size={15} />
            </button>
          </div>
        )}
      </div>

      {dash.widgets.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Dashboard vazio. {editable ? 'Clique em "Widget" para adicionar o primeiro gráfico.' : ''}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {dash.widgets.map((w, i) => (
          <div
            key={w.id}
            className={clsx(
              w.size === 'lg' && 'md:col-span-2 xl:col-span-3',
              w.size === 'md' && 'xl:col-span-1',
            )}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragFrom.current !== null) { void reorder(dragFrom.current, i); dragFrom.current = null } }}
          >
            <WidgetCard
              widget={w}
              metrics={metrics}
              editable={editable}
              onDelete={() => void deleteWidget(w.id)}
              onResize={(size) => void resizeWidget(w.id, size)}
              dragHandleProps={{
                draggable: true,
                onDragStart: () => { dragFrom.current = i },
              }}
            />
          </div>
        ))}
      </div>

      {showAdd && <AddWidgetModal metrics={metrics} onClose={() => setShowAdd(false)} onCreate={addWidget} />}
      {showShare && <ShareDialog dashboardId={dash.id} onClose={() => setShowShare(false)} />}
    </div>
  )
}
