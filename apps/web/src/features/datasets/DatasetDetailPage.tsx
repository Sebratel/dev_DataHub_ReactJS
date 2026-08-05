// Detalhe do Conjunto de Dados — página de "ativo" do lake: cabeçalho
// estruturado, faixa de metadados, ações (explorar/editar/acessos/excluir) e
// seções em cards. Usuários veem campos e dados; admins/donos gerenciam.
import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Eye, EyeOff, ShieldAlert, Table2, Loader2, Pencil, Check,
  Compass, GitMerge, RefreshCw, Shield, MoreVertical, Trash2, Database,
  Rows3, Columns3, Clock, AlertTriangle, BadgeCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import type { DatasetDetail, AdminDatasetField } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import OfficialBadge from '@/components/OfficialBadge'
import SyncPanel from './SyncPanel'
import DataTable from './DataTable'
import AccessDialog from './AccessDialog'
import EditDatasetDialog from './EditDatasetDialog'

const TYPE_LABEL: Record<string, string> = {
  text: 'Texto', number: 'Número', date: 'Data', bool: 'Sim/Não', json: 'Estruturado',
}

function fmtInt(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('pt-BR')
}
function relativeTime(iso: string | null): string {
  if (!iso) return 'Nunca'
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'agora mesmo'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  if (d < 30) return `há ${d} dia${d > 1 ? 's' : ''}`
  return `há ${Math.floor(d / 30)} mês(es)`
}

// Card de métrica do topo — leitura rápida do estado do ativo.
function StatTile({ icon: Icon, label, value, accent }: {
  icon: LucideIcon
  label: string; value: ReactNode; accent?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3.5 shadow-card dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
        <Icon size={12} /> {label}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[14px] font-semibold tabular-nums">
        {value}{accent}
      </div>
    </div>
  )
}

export default function DatasetDetailPage() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const isAdmin = useAuthStore((s) => !!s.user?.roles.includes('admin'))
  const canEdit = useAuthStore((s) => !!s.user?.roles.some((r) => r === 'admin' || r === 'editor'))
  const userEmail = useAuthStore((s) => s.user?.email ?? null)

  const [dataset, setDataset] = useState<DatasetDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Record<string, unknown>[] | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [editingField, setEditingField] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [materializing, setMaterializing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showAccess, setShowAccess] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(() => {
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${slug}`)
      .then((r) => setDataset(r.dataset))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }, [slug])
  useEffect(() => { load() }, [load])

  async function patchField(field: AdminDatasetField, patch: Partial<AdminDatasetField>) {
    if (!dataset) return
    try {
      await api(`/api/v1/datasets/${dataset.id}/fields/${field.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar campo.')
    }
  }

  async function loadPreview() {
    if (!dataset) return
    setMenuOpen(false)
    setPreviewBusy(true)
    setPreview(null)
    try {
      const r = await api<{ rows: Record<string, unknown>[] }>(`/api/v1/datasets/${dataset.slug}/preview`)
      setPreview(r.rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha na pré-visualização.')
    } finally {
      setPreviewBusy(false)
    }
  }

  if (error && !dataset) {
    return (
      <div className="mx-auto max-w-6xl">
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>
      </div>
    )
  }
  if (!dataset) {
    return (
      <div className="mx-auto flex max-w-5xl items-center gap-2 text-sm text-zinc-500">
        <Loader2 size={15} className="animate-spin" /> Carregando…
      </div>
    )
  }

  const derived = dataset.kind === 'derived'
  const canManage = isAdmin || (!!userEmail && dataset.ownerEmail === userEmail)
  const fresh = !!dataset.lastSyncAt && Date.now() - new Date(dataset.lastSyncAt).getTime() < 26 * 3600_000

  async function materializeNow() {
    if (!dataset) return
    setMenuOpen(false)
    setMaterializing(true)
    try {
      await api(`/api/v1/datasets/derived/${dataset.id}/materialize`, { method: 'POST', body: '{}' })
      setTimeout(() => { setMaterializing(false); load() }, 2500)
    } catch (e) {
      setMaterializing(false)
      setError(e instanceof Error ? e.message : 'Falha ao materializar.')
    }
  }

  async function toggleOfficial() {
    if (!dataset) return
    setMenuOpen(false)
    try {
      await api(`/api/v1/datasets/${dataset.id}`, {
        method: 'PATCH', body: JSON.stringify({ official: !dataset.official }),
      })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao alterar o selo oficial.')
    }
  }

  async function doDelete() {
    if (!dataset) return
    setDeleting(true)
    try {
      await api(`/api/v1/datasets/${dataset.id}`, { method: 'DELETE' })
      navigate('/datasets')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir.')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const visibleFields = dataset.fields.filter((f) => !f.hidden)
  const previewColumns = preview?.length ? Object.keys(preview[0]) : []
  const labelByKey = new Map(dataset.fields.map((f) => [f.key, f.label]))

  const menuItem = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800'

  return (
    <div className="mx-auto max-w-6xl animate-fade-in">
      {/* Trilha */}
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-zinc-500">
        <Link to="/datasets" className="inline-flex items-center gap-1.5 hover:text-accent">
          <ArrowLeft size={14} /> Catálogo
        </Link>
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <span className="truncate text-zinc-700 dark:text-zinc-300">{dataset.name}</span>
      </nav>

      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3.5">
          <div className={clsx('flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl shadow-card',
            derived ? 'bg-gradient-brand text-[#1a1a1a]' : 'bg-accent-soft text-accent dark:bg-zinc-800')}>
            {derived ? <GitMerge size={22} /> : <Database size={22} />}
          </div>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
              <span className="truncate">{dataset.name}</span>
              {dataset.official && <OfficialBadge size="md" />}
              <span className={clsx('shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                derived ? 'bg-accent-soft text-secondary dark:bg-zinc-800' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800')}>
                {derived ? 'Calculado' : 'Fonte'}
              </span>
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-zinc-500">{dataset.description || 'Sem descrição.'}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
              <span>Dono: {dataset.ownerEmail ?? '—'}</span>
              {dataset.tags.map((t) => (
                <span key={t} className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-500 dark:bg-zinc-800">{t}</span>
              ))}
              {isAdmin && !derived && dataset.source && (
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-zinc-800">
                  {dataset.source.connectionId}: {dataset.source.schema}.{dataset.source.table}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Ações */}
        <div className="flex shrink-0 items-center gap-2">
          {dataset.lastSyncAt && (
            <Link to={`/datasets/${dataset.slug}/explore`}
              className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-zinc-950 shadow-card transition-colors hover:bg-accent-hover">
              <Compass size={15} /> Explorar
            </Link>
          )}
          {canManage && (
            <button onClick={() => setShowAccess(true)}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              <Shield size={15} /> Acessos
            </button>
          )}
          {canManage && (
            <div className="relative">
              <button onClick={() => setMenuOpen((v) => !v)} aria-label="Mais ações"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                {materializing || previewBusy ? <Loader2 size={16} className="animate-spin" /> : <MoreVertical size={16} />}
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1.5 w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-card-lg animate-slide-up dark:border-zinc-800 dark:bg-zinc-900">
                    <button className={menuItem} onClick={() => { setShowEdit(true); setMenuOpen(false) }}>
                      <Pencil size={15} className="text-zinc-400" /> Editar nome e descrição
                    </button>
                    {isAdmin && (
                      <button className={menuItem} onClick={() => void toggleOfficial()}>
                        <BadgeCheck size={15} className={dataset.official ? 'text-secondary' : 'text-zinc-400'} />
                        {dataset.official ? 'Remover selo oficial' : 'Marcar como oficial'}
                      </button>
                    )}
                    {derived && canEdit && (
                      <>
                        <Link to={`/datasets/derived/new?slug=${dataset.slug}`} className={menuItem}>
                          <GitMerge size={15} className="text-zinc-400" /> Editar SQL
                        </Link>
                        <button className={menuItem} onClick={() => void materializeNow()}>
                          <RefreshCw size={15} className="text-zinc-400" /> Atualizar agora
                        </button>
                      </>
                    )}
                    {isAdmin && !derived && (
                      <button className={menuItem} onClick={() => void loadPreview()}>
                        <Table2 size={15} className="text-zinc-400" /> Preview da fonte
                      </button>
                    )}
                    <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
                    <button className={clsx(menuItem, 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40')}
                      onClick={() => { setConfirmDelete(true); setMenuOpen(false) }}>
                      <Trash2 size={15} /> Excluir conjunto
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      {/* Faixa de metadados */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={Rows3} label="Registros" value={fmtInt(dataset.rowCount)} />
        <StatTile icon={Columns3} label="Campos" value={visibleFields.length} />
        <StatTile icon={Clock} label="Última sincronização"
          value={<span className="text-[13px] font-medium">{relativeTime(dataset.lastSyncAt)}</span>}
          accent={dataset.lastSyncAt
            ? <span className={clsx('h-2 w-2 rounded-full', fresh ? 'bg-emerald-500' : 'bg-amber-500')} />
            : <span className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600" />} />
        <StatTile icon={derived ? GitMerge : Database} label="Tipo"
          value={<span className="text-[13px] font-medium">{derived ? 'Calculado' : 'Fonte'}</span>} />
      </div>

      {/* Campos (schema) */}
      <section className="mt-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Campos</h2>
          {isAdmin && (
            <span className="flex items-center gap-3 text-[11px] text-zinc-400">
              <span className="flex items-center gap-1"><Eye size={12} /> visível</span>
              <span className="flex items-center gap-1"><ShieldAlert size={12} className="text-amber-500" /> sensível</span>
            </span>
          )}
        </div>
        <div className="overflow-hidden rounded-xl border border-zinc-200 shadow-card dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2.5 font-medium">Campo</th>
                <th className="px-4 py-2.5 font-medium">Tipo</th>
                <th className="px-4 py-2.5 font-medium">Descrição</th>
                {isAdmin && <th className="px-4 py-2.5 text-right font-medium">Controles</th>}
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-zinc-950">
              {(isAdmin ? dataset.fields : visibleFields).map((f) => (
                <tr key={f.id} className={clsx('border-t border-zinc-100 transition-colors hover:bg-zinc-50/60 dark:border-zinc-800 dark:hover:bg-zinc-900/40', f.hidden && 'opacity-45')}>
                  <td className="px-4 py-2">
                    {isAdmin && editingField === f.id ? (
                      <span className="flex items-center gap-1.5">
                        <input autoFocus value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { patchField(f, { label: labelDraft }); setEditingField(null) } }}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
                        <button onClick={() => { patchField(f, { label: labelDraft }); setEditingField(null) }} className="text-emerald-600"><Check size={15} /></button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 font-medium">
                        {f.label}
                        {f.sensitive && <ShieldAlert size={13} className="text-amber-500" />}
                        {isAdmin && (
                          <button onClick={() => { setEditingField(f.id); setLabelDraft(f.label) }}
                            className="text-zinc-300 hover:text-accent dark:text-zinc-600"><Pencil size={12} /></button>
                        )}
                      </span>
                    )}
                    <span className="ml-0.5 block font-mono text-[10px] text-zinc-400">{f.key}</span>
                  </td>
                  <td className="px-4 py-2 text-zinc-500">{TYPE_LABEL[f.type] ?? f.type}</td>
                  <td className="px-4 py-2 text-zinc-500">{f.description ?? '—'}</td>
                  {isAdmin && (
                    <td className="px-4 py-2 text-right">
                      <span className="inline-flex gap-1">
                        <button title={f.hidden ? 'Exibir campo' : 'Ocultar campo'} onClick={() => patchField(f, { hidden: !f.hidden })}
                          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800">
                          {f.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                        <button title={f.sensitive ? 'Desmarcar sensível' : 'Marcar como sensível'} onClick={() => patchField(f, { sensitive: !f.sensitive })}
                          className={clsx('rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800', f.sensitive ? 'text-amber-500' : 'text-zinc-400 hover:text-zinc-700')}>
                          <ShieldAlert size={15} />
                        </button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* SQL do derivado (editores/admins) */}
      {derived && dataset.transformSql != null && (
        <section className="mt-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">SQL da transformação</h2>
          <pre className="overflow-x-auto rounded-xl border border-zinc-200 bg-white p-3 font-mono text-xs leading-relaxed shadow-card dark:border-zinc-800 dark:bg-zinc-950">
            {dataset.transformSql}
          </pre>
        </section>
      )}

      {/* Sincronização com o lake (admin; fontes) */}
      {isAdmin && !derived && <SyncPanel dataset={dataset} onSynced={load} />}

      {/* Dados do lake — qualquer usuário, quando já sincronizado */}
      {dataset.lastSyncAt && <DataTable dataset={dataset} />}

      {/* Preview ao vivo da fonte (admin) */}
      {preview && (
        <section className="mt-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Amostra (50 primeiras linhas, sensíveis mascarados)
          </h2>
          <div className="max-h-96 overflow-auto rounded-xl border border-zinc-200 shadow-card dark:border-zinc-800">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                <tr>
                  {previewColumns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{labelByKey.get(c) ?? c}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-zinc-950">
                {preview.map((row, i) => (
                  <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                    {previewColumns.map((c) => (
                      <td key={c} className="max-w-[220px] truncate whitespace-nowrap px-3 py-1.5">
                        {row[c] === null || row[c] === undefined ? '—' : String(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Diálogos */}
      {showAccess && <AccessDialog slug={dataset.slug} name={dataset.name} onClose={() => setShowAccess(false)} />}
      {showEdit && (
        <EditDatasetDialog id={dataset.id} name={dataset.name} description={dataset.description}
          tags={dataset.tags} onSaved={load} onClose={() => setShowEdit(false)} />
      )}
      {confirmDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3 animate-fade-in" onClick={() => setConfirmDelete(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-3.5 shadow-card-lg dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-950/40">
                <AlertTriangle size={18} />
              </div>
              <div>
                <h2 className="font-semibold">Excluir “{dataset.name}”?</h2>
                <p className="mt-1 text-sm text-zinc-500">
                  Remove o conjunto do catálogo e todas as suas configurações — campos, métricas,
                  dashboards vinculados e concessões de acesso. Esta ação não pode ser desfeita.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)}
                className="rounded-lg border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                Cancelar
              </button>
              <button onClick={() => void doDelete()} disabled={deleting}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Excluir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
