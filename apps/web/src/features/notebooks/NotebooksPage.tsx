// Lista de notebooks. Deliberadamente simples: o valor está lá dentro, e uma
// lista de análises é escaneada por NOME e por QUEM FEZ, não por métrica.
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { NotebookText, Plus, Lock, Users, AlertTriangle, Loader2 } from 'lucide-react'
import type { NotebookSummary } from '@datahub/shared'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}

export default function NotebooksPage() {
  const navigate = useNavigate()
  const email = useAuthStore((s) => s.user)?.email
  const [items, setItems] = useState<NotebookSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
                    </Tr>
                  ))}
                </tbody>
              </DataGrid>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
