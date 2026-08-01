// Admin › Conexões — status ao vivo das fontes e descoberta de tabelas
// (matéria-prima da publicação de datasets no Sprint 2).
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, XCircle, CircleDashed, RefreshCw, Table2, Upload, Loader2, Plus, Pencil, Trash2, Globe } from 'lucide-react'
import type { ConnectionInfo } from '@datahub/shared'
import { api } from '@/lib/api'
import { usePrompt, useConfirm } from '@/components/Dialogs'
import ConnectionDialog from './ConnectionDialog'
import ApiDatasetDialog from './ApiDatasetDialog'

interface PhysicalObject { schema: string; name: string; kind: 'table' | 'view'; columns: number }

export default function ConnectionsPage() {
  const navigate = useNavigate()
  const prompt = usePrompt()
  const confirm = useConfirm()
  const [dialog, setDialog] = useState<'new' | ConnectionInfo | null>(null)
  const [apiFor, setApiFor] = useState<ConnectionInfo | null>(null)
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [objects, setObjects] = useState<PhysicalObject[] | null>(null)
  const [objectsBusy, setObjectsBusy] = useState(false)
  const [publishing, setPublishing] = useState<string | null>(null)

  // Publica a tabela como Conjunto de Dados e leva para a edição do catálogo.
  async function publish(connectionId: string, obj: PhysicalObject) {
    const name = await prompt({
      title: 'Publicar conjunto',
      label: `Nome amigável (o usuário verá este nome, nunca "${obj.name}")`,
      initial: obj.name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      confirmLabel: 'Publicar',
    })
    if (!name) return
    setPublishing(`${obj.schema}.${obj.name}`)
    setError(null)
    try {
      const r = await api<{ slug: string }>('/api/v1/datasets', {
        method: 'POST',
        body: JSON.stringify({ connectionId, schema: obj.schema, table: obj.name, name }),
      })
      navigate(`/datasets/${r.slug}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao publicar o conjunto.')
    } finally {
      setPublishing(null)
    }
  }

  async function load() {
    setConnections(null)
    setError(null)
    try {
      const r = await api<{ connections: ConnectionInfo[] }>('/api/v1/connections')
      setConnections(r.connections)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar conexões.')
    }
  }

  useEffect(() => { void load() }, [])

  async function openObjects(id: string) {
    setSelected(id)
    setObjects(null)
    setObjectsBusy(true)
    try {
      const r = await api<{ objects: PhysicalObject[] }>(`/api/v1/connections/${id}/objects`)
      setObjects(r.objects)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao listar tabelas.')
    } finally {
      setObjectsBusy(false)
    }
  }

  async function remove(c: ConnectionInfo) {
    const reverting = c.native && c.managed
    if (!(await confirm({
      title: reverting ? 'Reverter para o .env' : 'Excluir conexão',
      message: reverting
        ? `Remover a personalização de "${c.name}" e voltar às credenciais do .env?`
        : `Excluir a conexão "${c.name}"? Conjuntos que dependem dela deixarão de sincronizar.`,
      danger: true, confirmLabel: reverting ? 'Reverter' : 'Excluir',
    }))) return
    try {
      await api(`/api/v1/connections/${c.id}`, { method: 'DELETE' })
      void load()
    } catch (e) {
      // 409 = há datasets usando; oferece forçar.
      const msg = e instanceof Error ? e.message : 'Falha ao excluir.'
      if (/force=true/.test(msg) && await confirm({ title: 'Excluir mesmo assim?', message: msg, danger: true, confirmLabel: 'Excluir assim mesmo' })) {
        await api(`/api/v1/connections/${c.id}?force=true`, { method: 'DELETE' }).then(load).catch((e2) =>
          setError(e2 instanceof Error ? e2.message : 'Falha ao excluir.'))
      } else {
        setError(msg)
      }
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Conexões</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Fontes de dados do hub. As fixas vêm do servidor (.env); as gerenciadas você cadastra aqui (senha criptografada, nunca exibida).
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setDialog('new')}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover"
          >
            <Plus size={15} /> Nova conexão
          </button>
          <button
            onClick={load}
            className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <RefreshCw size={14} /> Atualizar
          </button>
        </div>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      <div className="mt-6 grid gap-3">
        {connections === null && !error && <p className="text-sm text-zinc-500">Verificando fontes…</p>}
        {connections?.map((c) => (
          <div key={c.id} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-3">
              {c.status === 'ok' && <CheckCircle2 size={18} className="text-emerald-500" />}
              {c.status === 'error' && <XCircle size={18} className="text-red-500" />}
              {c.status === 'unknown' && <CircleDashed size={18} className="text-zinc-400" />}
              <div className="flex-1">
                <p className="flex items-center gap-2 font-medium">
                  {c.name}
                  {!c.native
                    ? <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-secondary dark:bg-zinc-800">gerenciada</span>
                    : c.managed
                      ? <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-secondary dark:bg-zinc-800">personalizada</span>
                      : <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">.env</span>}
                </p>
                <p className="text-xs text-zinc-500">
                  {c.kind}
                  {c.detail ? ` · ${c.detail.host}:${c.detail.port}/${c.detail.database}` : (c.envPrefix ? ` · ${c.envPrefix}_*` : '')}
                  {c.latencyMs !== null && c.status === 'ok' && ` · ${c.latencyMs} ms`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {c.status === 'ok' && (c.kind === 'http' ? (
                  <button
                    onClick={() => setApiFor(c)}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    <Globe size={13} /> Publicar API
                  </button>
                ) : (
                  <button
                    onClick={() => openObjects(c.id)}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    <Table2 size={13} /> Ver tabelas
                  </button>
                ))}
                <button onClick={() => setDialog(c)} title={c.native ? 'Personalizar (sobrepõe o .env)' : 'Editar conexão'}
                  className="rounded-lg border border-zinc-200 p-1.5 text-zinc-400 hover:text-accent dark:border-zinc-700">
                  <Pencil size={14} />
                </button>
                {c.managed && (
                  <button onClick={() => void remove(c)} title={c.native ? 'Reverter para o .env' : 'Excluir conexão'}
                    className="rounded-lg border border-zinc-200 p-1.5 text-zinc-400 hover:text-red-500 dark:border-zinc-700">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
            {c.error && <p className="mt-2 text-xs text-red-500">{c.error}</p>}
            {selected === c.id && (
              <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                {objectsBusy && <p className="text-sm text-zinc-500">Descobrindo tabelas…</p>}
                {objects && (
                  <>
                    <p className="mb-2 text-xs text-zinc-500">{objects.length} objetos encontrados</p>
                    <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-100 dark:border-zinc-800">
                      <table className="w-full text-left text-sm">
                        <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-800">
                          <tr>
                            <th className="px-3 py-2 font-medium">Schema</th>
                            <th className="px-3 py-2 font-medium">Nome</th>
                            <th className="px-3 py-2 font-medium">Tipo</th>
                            <th className="px-3 py-2 text-right font-medium">Colunas</th>
                            <th className="px-3 py-2 text-right font-medium">Catálogo</th>
                          </tr>
                        </thead>
                        <tbody>
                          {objects.map((o) => (
                            <tr key={`${o.schema}.${o.name}`} className="border-t border-zinc-100 dark:border-zinc-800">
                              <td className="px-3 py-1.5 text-zinc-500">{o.schema}</td>
                              <td className="px-3 py-1.5 font-mono text-xs">{o.name}</td>
                              <td className="px-3 py-1.5">{o.kind === 'view' ? 'view' : 'tabela'}</td>
                              <td className="px-3 py-1.5 text-right">{o.columns}</td>
                              <td className="px-3 py-1.5 text-right">
                                <button
                                  onClick={() => publish(c.id, o)}
                                  disabled={publishing !== null}
                                  className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-1 text-[11px] hover:border-accent hover:text-accent disabled:opacity-50 dark:border-zinc-700"
                                >
                                  {publishing === `${o.schema}.${o.name}`
                                    ? <Loader2 size={11} className="animate-spin" />
                                    : <Upload size={11} />}
                                  Publicar
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {dialog && (
        <ConnectionDialog
          existing={dialog === 'new' ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={load}
        />
      )}
      {apiFor && <ApiDatasetDialog connection={apiFor} onClose={() => setApiFor(null)} />}
    </div>
  )
}
