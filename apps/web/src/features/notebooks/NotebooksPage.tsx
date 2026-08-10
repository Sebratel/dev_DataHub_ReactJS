// Lista de notebooks. Deliberadamente simples: o valor está lá dentro, e uma
// lista de análises é escaneada por NOME e por QUEM FEZ, não por métrica.
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { NotebookText, Plus, Lock, Users, AlertTriangle, Loader2, Trash2, Share2 } from 'lucide-react'
import type { NotebookSummary } from '@datahub/shared'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'
import { useConfirm } from '@/components/Dialogs'
import ShareNotebookDialog from './ShareNotebookDialog'

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}

export default function NotebooksPage() {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const me = useAuthStore((s) => s.user)
  const email = me?.email
  const isAdmin = !!me?.roles?.includes('admin')
  const [items, setItems] = useState<NotebookSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sharing, setSharing] = useState<NotebookSummary | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setItems((await api<{ notebooks: NotebookSummary[] }>('/api/v1/notebooks')).notebooks)
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function create() {
    setCreating(true)
    try {
      const r = await api<{ notebook: NotebookSummary }>('/api/v1/notebooks', {
        method: 'POST',
        body: JSON.stringify({ name: 'Análise sem título' }),
      })
      navigate(`/notebooks/${r.notebook.slug}`)
    } catch (e) {
      setError((e as ApiError).message)
      setCreating(false)
    }
  }

  // Excluir é definitivo: as células vão junto e não há lixeira. Por isso o
  // aviso nomeia o notebook — clicar na linha errada é o erro provável aqui.
  async function remove(n: NotebookSummary) {
    const ok = await confirm({
      title: 'Excluir notebook',
      message: `"${n.name}" e todas as suas células serão apagados. Conjuntos já materializados a partir dele continuam existindo. Não dá para desfazer.`,
      confirmLabel: 'Excluir',
      danger: true,
    })
    if (!ok) return
    setRemoving(n.slug)
    setError(null)
    try {
      await api(`/api/v1/notebooks/${n.slug}`, { method: 'DELETE' })
      setItems((cur) => cur.filter((x) => x.slug !== n.slug))
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="mx-auto min-w-0 max-w-[1600px]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Notebooks</h1>
          <p className="mt-0.5 text-[12px] text-zinc-500">
            SQL sobre o lake, em células. Nenhuma carga nas fontes de produção.
          </p>
        </div>
        <button onClick={() => void create()} disabled={creating}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-60 active:scale-95">
          {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} strokeWidth={2} />}
          Novo notebook
        </button>
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2.5 rounded-2xl border border-crit/40 bg-crit-soft p-3 dark:bg-crit/10">
          <AlertTriangle size={15} className="shrink-0 text-crit dark:text-crit-dark" />
          <p className="text-[12px] text-crit dark:text-crit-dark">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="mt-3.5 h-[220px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
      ) : (
        <div className="mt-3.5">
          <Card>
            <CardHead icon={NotebookText} title="Suas análises" sub={`${items.length}`} />
            {items.length === 0 ? (
              <div className="px-3 py-10 text-center">
                <NotebookText size={26} strokeWidth={1.2} className="mx-auto mb-2 text-zinc-300 dark:text-zinc-700" />
                <p className="text-[12px] text-zinc-500">
                  Nenhum notebook ainda. Um notebook é uma sequência de células SQL sobre os conjuntos do lake.
                </p>
                <button onClick={() => void create()} className="mt-1.5 text-[12px] font-medium text-info hover:underline dark:text-info-dark">
                  Criar o primeiro
                </button>
              </div>
            ) : (
              <DataGrid>
                <thead>
                  <tr>
                    <Th>Notebook</Th>
                    <Th right className="w-[80px]">Células</Th>
                    <Th className="w-[104px]">Visibilidade</Th>
                    <Th className="w-[180px]">Dono</Th>
                    <Th className="w-[96px]">Editado</Th>
                    <Th right className="w-[76px]"><span className="sr-only">Ações</span></Th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((n) => (
                    <Tr key={n.id}>
                      <Td>
                        <Link to={`/notebooks/${n.slug}`} className="block hover:text-info dark:hover:text-info-dark">
                          <EntityCell name={n.name} slug={n.description || n.slug}>
                            <NotebookText size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                          </EntityCell>
                        </Link>
                      </Td>
                      <Td right muted>{n.cell_count}</Td>
                      <Td>
                        {n.visibility === 'tenant'
                          ? <Pill tone="info"><Users size={10} /> time</Pill>
                          : <Pill><Lock size={10} /> privado</Pill>}
                      </Td>
                      <Td muted>
                        {n.owner_email === email ? 'você' : n.owner_email}
                      </Td>
                      <Td muted>há {timeAgo(n.updated_at)}</Td>
                      <Td right>
                        {/* Só dono e admin: quem recebeu acesso não decide quem
                            mais entra, nem apaga o trabalho de outra pessoa. */}
                        {n.owner_email === email || isAdmin ? (
                          <div className="flex items-center justify-end gap-0.5">
                            <button onClick={() => setSharing(n)} title="Gerenciar acessos"
                              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
                              <Share2 size={13} strokeWidth={1.6} />
                            </button>
                            <button onClick={() => void remove(n)} disabled={removing === n.slug} title="Excluir notebook"
                              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-crit-soft hover:text-crit disabled:opacity-50 dark:hover:bg-crit/10 dark:hover:text-crit-dark">
                              {removing === n.slug
                                ? <Loader2 size={13} className="animate-spin" />
                                : <Trash2 size={13} strokeWidth={1.6} />}
                            </button>
                          </div>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </DataGrid>
            )}
          </Card>
        </div>
      )}

      {sharing && (
        <ShareNotebookDialog
          slug={sharing.slug}
          onClose={() => { setSharing(null); void load() }}
          onVisibility={(v) => setItems((cur) =>
            cur.map((x) => (x.slug === sharing.slug ? { ...x, visibility: v } : x)))}
        />
      )}
    </div>
  )
}
