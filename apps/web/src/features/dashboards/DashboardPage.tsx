// Página de um dashboard: abas (guias) + canvas livre (react-grid-layout, 12
// colunas, arrastar/redimensionar). O layout de cada widget (x/y/w/h) é salvo
// por aba ao soltar. No modo de visualização o painel fica estático e limpo;
// no modo de edição habilitam-se arraste, redimensionamento e gestão de abas.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2, Share2, Pencil, LayoutGrid, Check, Sparkles } from 'lucide-react'
import RGL, { WidthProvider, type Layout } from 'react-grid-layout'
import type { DashboardDetail, Metric, Widget } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import WidgetCard from './WidgetCard'
import AddWidgetModal from './AddWidgetModal'
import ShareDialog from './ShareDialog'
import EditDashboardDialog from './EditDashboardDialog'
import TabBar from './TabBar'
import AiWidgetPanel from './AiWidgetPanel'
import { resolveLayout, GRID_COLS, GRID_ROW_H } from './gridLayout'
import { useConfirm } from '@/components/Dialogs'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import './grid.css'

const GridLayout = WidthProvider(RGL)

type WidgetInput = Parameters<Parameters<typeof AddWidgetModal>[0]['onSubmit']>[0]

export default function DashboardPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const confirm = useConfirm()
  const [dash, setDash] = useState<DashboardDetail | null>(null)
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null)
  const [showEditDash, setShowEditDash] = useState(false)
  const [showAi, setShowAi] = useState(false)
  const [activeTabId, setActiveTabId] = useState<string>('')
  const [editMode, setEditMode] = useState(false)

  const load = useCallback((switchTo?: string) => {
    api<{ dashboard: DashboardDetail }>(`/api/v1/dashboards/${id}`)
      .then((r) => {
        setDash(r.dashboard)
        setActiveTabId((cur) => {
          if (switchTo) return switchTo
          const exists = r.dashboard.tabs.some((t) => t.id === cur)
          return exists ? cur : (r.dashboard.tabs[0]?.id ?? '')
        })
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }, [id])

  useEffect(() => {
    load()
    api<{ metrics: Metric[] }>('/api/v1/metrics').then((r) => setMetrics(r.metrics)).catch(() => {})
  }, [load])

  const editable = !!user && (user.roles.includes('admin') ||
    (user.roles.includes('editor') && dash?.ownerEmail === user.email) || dash?.ownerEmail === user.email)

  const tabWidgets = useMemo(
    () => (dash?.widgets ?? []).filter((w) => w.tabId === activeTabId),
    [dash, activeTabId],
  )
  const layout = useMemo(() => resolveLayout(tabWidgets), [tabWidgets])

  async function addWidget(w: WidgetInput) {
    await api(`/api/v1/dashboards/${id}/widgets`, { method: 'POST', body: JSON.stringify({ ...w, tabId: activeTabId }) })
    load()
  }

  async function editWidget(w: WidgetInput) {
    if (!editingWidget) return
    await api(`/api/v1/dashboards/${id}/widgets/${editingWidget.id}`, { method: 'PATCH', body: JSON.stringify(w) })
    load()
  }

  async function deleteWidget(widgetId: string) {
    await api(`/api/v1/dashboards/${id}/widgets/${widgetId}`, { method: 'DELETE' })
    load()
  }

  // Salva o layout do grid (posições x/y/w/h) da aba ativa ao soltar/redimensionar.
  function persistLayout(next: Layout[]) {
    setDash((d) => d && ({
      ...d,
      widgets: d.widgets.map((w) => {
        const l = next.find((x) => x.i === w.id)
        return l && w.tabId === activeTabId ? { ...w, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : w
      }),
    }))
    void api(`/api/v1/dashboards/${id}/layout`, {
      method: 'PUT',
      body: JSON.stringify({
        widgets: next.map((l) => ({ id: l.i, layout: { x: l.x, y: l.y, w: l.w, h: l.h }, tabId: activeTabId })),
      }),
    }).catch(() => {})
  }

  async function deleteDashboard() {
    if (!(await confirm({
      title: 'Excluir dashboard',
      message: `Excluir o dashboard "${dash?.name}"? Esta ação não pode ser desfeita.`,
      danger: true, confirmLabel: 'Excluir',
    }))) return
    await api(`/api/v1/dashboards/${id}`, { method: 'DELETE' })
    navigate('/dashboards')
  }

  if (error) return <p className="rounded-lg bg-red-50 p-4 text-sm text-red-600 dark:bg-red-950/40">{error}</p>
  if (!dash) return <p className="text-sm text-zinc-500">Carregando…</p>

  return (
    <div className="mx-auto max-w-7xl">
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
            <button onClick={() => setEditMode((v) => !v)}
              className={editMode
                ? 'flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover'
                : 'flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-600 hover:text-accent dark:border-zinc-700'}
              title="Ativar arraste, redimensionamento e gestão de abas">
              {editMode ? <Check size={15} /> : <LayoutGrid size={15} />}
              {editMode ? 'Concluir' : 'Editar layout'}
            </button>
            <button onClick={() => setShowAi(true)}
              className="flex items-center gap-2 rounded-lg border border-accent/60 px-3 py-2 text-sm text-accent hover:bg-accent/10"
              title="Descreva o painel e a IA monta os gráficos">
              <Sparkles size={15} /> Criar com IA
            </button>
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover">
              <Plus size={15} /> Widget
            </button>
            <button onClick={() => setShowEditDash(true)} title="Editar nome e descrição"
              className="rounded-lg border border-zinc-200 p-2 text-zinc-400 hover:text-accent dark:border-zinc-700">
              <Pencil size={15} />
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

      {/* Abas */}
      <div className="mt-5">
        <TabBar
          dashboardId={dash.id}
          tabs={dash.tabs}
          activeTabId={activeTabId}
          editMode={editMode && editable}
          onSwitch={setActiveTabId}
          onChanged={(opts) => load(opts?.switchTo)}
        />
      </div>

      {tabWidgets.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Aba vazia. {editable ? 'Clique em "Widget" para adicionar o primeiro gráfico.' : ''}
        </div>
      ) : (
        <GridLayout
          className="mt-3"
          cols={GRID_COLS}
          rowHeight={GRID_ROW_H}
          layout={layout}
          isDraggable={editMode && editable}
          isResizable={editMode && editable}
          draggableHandle=".widget-drag"
          onDragStop={persistLayout}
          onResizeStop={persistLayout}
          margin={[12, 12]}
          containerPadding={[0, 0]}
          compactType="vertical"
        >
          {tabWidgets.map((w) => (
            <div key={w.id}>
              <WidgetCard
                widget={w}
                metrics={metrics}
                editable={editMode && editable}
                fill
                onDelete={() => void deleteWidget(w.id)}
                onEdit={editMode && editable ? () => setEditingWidget(w) : undefined}
              />
            </div>
          ))}
        </GridLayout>
      )}

      {showAdd && <AddWidgetModal metrics={metrics} onClose={() => setShowAdd(false)} onSubmit={addWidget} />}
      {editingWidget && (
        <AddWidgetModal
          metrics={metrics}
          initial={editingWidget}
          onClose={() => setEditingWidget(null)}
          onSubmit={editWidget}
        />
      )}
      {showEditDash && (
        <EditDashboardDialog
          dashboardId={dash.id}
          initialName={dash.name}
          initialDescription={dash.description ?? ''}
          onClose={() => setShowEditDash(false)}
          onSaved={load}
        />
      )}
      {showShare && <ShareDialog dashboardId={dash.id} onClose={() => setShowShare(false)} />}
      {showAi && (
        <AiWidgetPanel
          dashboardId={dash.id}
          tabId={activeTabId}
          onClose={() => setShowAi(false)}
          onAdded={() => load()}
        />
      )}
    </div>
  )
}
