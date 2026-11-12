// Lixeira de conjuntos (D-DSP-3 do comitê). Excluir um conjunto manda para cá:
// a definição e os dados esperam 30 dias. Quem excluiu, o dono ou um admin
// restaura; excluir de vez é só de admin (D-DSP-2). Depois do prazo, o
// sistema exclui de vez sozinho.
//
// Admin vê a lixeira inteira; os demais, o que excluíram ou o que era deles.
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Trash2, RotateCcw, Loader2, GitMerge, Database } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import { Page, PageHeader, EmptyState, ErrorBanner, TableSkeleton } from '@/components/ui/Page'
import { Card } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'

interface TrashItem {
  id: string
  kind: 'dataset'
  datasetKind: 'source' | 'derived'
  slug: string
  name: string
  ownerEmail: string | null
  deletedBy: string
  deletedAt: string
  expiresAt: string
  hasData: boolean
}

function diasAte(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000))
}

export default function TrashPage() {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const isAdmin = useAuthStore((s) => !!s.user?.roles.includes('admin'))
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const [days, setDays] = useState(30)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    api<{ items: TrashItem[]; days: number }>('/api/v1/trash')
      .then((r) => { setItems(r.items); setDays(r.days) })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar a lixeira.'))
  }, [])
  useEffect(load, [load])

  async function restaurar(it: TrashItem) {
    setBusy(it.id)
    setError(null)
    try {
      const r = await api<{ slug: string; renamed: boolean }>(`/api/v1/trash/${it.id}/restore`, { method: 'POST' })
      if (r.renamed) {
        await confirm({
          title: 'Restaurado com outro endereço',
          message: `Outro conjunto passou a usar "${it.slug}" enquanto este estava na lixeira. ` +
            `Ele voltou como "${r.slug}".`,
          confirmLabel: 'Abrir o conjunto',
        })
      }
      navigate(`/datasets/${r.slug}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao restaurar.')
      setBusy(null)
    }
  }

  async function excluirDeVez(it: TrashItem) {
    const ok = await confirm({
      title: `Excluir "${it.name}" de vez?`,
      message: 'A definição fica registrada, mas os dados do lake são apagados e o conjunto não pode mais ser restaurado.',
      confirmLabel: 'Excluir de vez',
      danger: true,
    })
    if (!ok) return
    setBusy(it.id)
    setError(null)
    try {
      await api(`/api/v1/trash/${it.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Page>
      <PageHeader
        icon={Trash2}
        title="Lixeira"
        subtitle={`Conjuntos excluídos esperam ${days} dias aqui. Depois disso, são excluídos de vez.`}
        back={(
          <Link to="/datasets" className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-accent">
            <ArrowLeft size={13} /> Conjuntos
          </Link>
        )}
      />

      {error && <ErrorBanner message={error} />}

      {items === null && !error ? <TableSkeleton /> : (
        <Card>
          {items && items.length === 0 ? (
            <EmptyState icon={Trash2} message={isAdmin
              ? 'A lixeira está vazia.'
              : 'Nada seu na lixeira. Aqui aparecem os conjuntos que você excluiu ou que eram seus.'} />
          ) : (
            <DataGrid fixed>
              <thead>
                <tr>
                  <Th>Conjunto</Th>
                  <Th className="w-[200px]">Excluído por</Th>
                  <Th className="w-[120px]">Quando</Th>
                  <Th className="w-[110px]" right>Restaura até</Th>
                  <Th className="w-[230px]" right>Ações</Th>
                </tr>
              </thead>
              <tbody>
                {items?.map((it) => {
                  const resta = diasAte(it.expiresAt)
                  return (
                    <Tr key={it.id}>
                      <Td>
                        <EntityCell name={it.name} slug={it.slug}>
                          {it.datasetKind === 'derived'
                            ? <GitMerge size={13} className="shrink-0 text-zinc-400" />
                            : <Database size={13} className="shrink-0 text-zinc-400" />}
                        </EntityCell>
                      </Td>
                      <Td muted className="truncate" title={it.ownerEmail ? `Dono: ${it.ownerEmail}` : undefined}>{it.deletedBy}</Td>
                      <Td muted>{new Date(it.deletedAt).toLocaleDateString('pt-BR')}</Td>
                      <Td right muted title={new Date(it.expiresAt).toLocaleString('pt-BR')}>
                        {resta === 0 ? 'hoje' : `${resta} dia${resta === 1 ? '' : 's'}`}
                      </Td>
                      <Td right>
                        <span className="inline-flex items-center gap-1.5">
                          <button
                            onClick={() => void restaurar(it)}
                            disabled={busy === it.id}
                            className="inline-flex h-[26px] items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[11.5px] font-medium transition-colors hover:border-zinc-300 disabled:opacity-50 dark:border-zinc-700"
                          >
                            {busy === it.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                            Restaurar
                          </button>
                          {isAdmin && (
                            <button
                              onClick={() => void excluirDeVez(it)}
                              disabled={busy === it.id}
                              className="inline-flex h-[26px] items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[11.5px] font-medium text-crit transition-colors hover:border-crit/50 disabled:opacity-50 dark:border-zinc-700 dark:text-crit-dark"
                            >
                              <Trash2 size={12} /> Excluir de vez
                            </button>
                          )}
                        </span>
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </DataGrid>
          )}
        </Card>
      )}
    </Page>
  )
}
