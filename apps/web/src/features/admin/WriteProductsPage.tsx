// Admin › Produtos de Escrita (Fase 4). Cria endpoints públicos de INSERT
// parametrizado numa conexão gravável. Só admin. O dev consome via
// POST /api/public/v1/w/<slug> com token que tenha o produto no escopo.
import { useEffect, useState } from 'react'
import { PenLine, Plus, Trash2, RefreshCw, Loader2, X } from 'lucide-react'
import type { ConnectionInfo } from '@datahub/shared'
import { api } from '@/lib/api'
import { useConfirm } from '@/components/Dialogs'

interface Column { col: string; type: 'text' | 'number' | 'bool' | 'date'; required: boolean }
interface Product {
  id: string; slug: string; name: string; connection_id: string
  schema_name: string; table_name: string; columns: Column[]; enabled: boolean
}

export default function WriteProductsPage() {
  const confirm = useConfirm()
  const [products, setProducts] = useState<Product[] | null>(null)
  const [conns, setConns] = useState<ConnectionInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  async function load() {
    setError(null)
    try { setProducts((await api<{ products: Product[] }>('/api/v1/write-products')).products) }
    catch (e) { setError(e instanceof Error ? e.message : 'Falha ao carregar.') }
  }
  useEffect(() => {
    void load()
    api<{ connections: ConnectionInfo[] }>('/api/v1/connections')
      .then((r) => setConns(r.connections.filter((c) => c.writable)))
      .catch(() => {})
  }, [])

  async function remove(p: Product) {
    if (!(await confirm({ title: 'Excluir produto', message: `Excluir a API de escrita "${p.name}"?`, danger: true, confirmLabel: 'Excluir' }))) return
    await api(`/api/v1/write-products/${p.id}`, { method: 'DELETE' }).then(load).catch((e) => setError(e instanceof Error ? e.message : 'Falha.'))
  }
  async function toggle(p: Product) {
    await api(`/api/v1/write-products/${p.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !p.enabled }) }).then(load).catch(() => {})
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <PenLine size={22} className="text-accent" /> Produtos de Escrita
          </h1>
          <p className="mt-1 text-sm text-zinc-500">APIs públicas de <strong>INSERT</strong> em bancos internos graváveis. Só admin cria; o dev consome via token. Toda escrita é auditada e monitorada.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setOpen(true)} disabled={!conns.length}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50"
            title={conns.length ? '' : 'Marque uma conexão como gravável primeiro (em Conexões)'}>
            <Plus size={15} /> Novo produto
          </button>
          <button onClick={load} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            <RefreshCw size={14} /> Atualizar
          </button>
        </div>
      </div>

      {!conns.length && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/30">
          Nenhuma conexão marcada como <strong>gravável</strong>. Vá em <strong>Conexões</strong>, edite (ou crie) uma conexão de banco interno e marque "Permitir escrita".
        </p>
      )}
      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      <div className="mt-5 grid gap-3">
        {products?.map((p) => (
          <div key={p.id} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-3">
              <span className={`h-2.5 w-2.5 rounded-full ${p.enabled ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{p.name}</p>
                <p className="truncate text-xs text-zinc-500">
                  <span className="font-mono">POST /api/public/v1/w/{p.slug}</span> → {p.connection_id}: {p.schema_name}.{p.table_name} · {p.columns.length} coluna(s)
                </p>
              </div>
              <button onClick={() => void toggle(p)} className={`rounded-lg border px-2 py-1 text-xs ${p.enabled ? 'border-zinc-200 text-zinc-600 dark:border-zinc-700' : 'border-accent bg-accent-soft text-secondary dark:bg-zinc-800'}`}>
                {p.enabled ? 'Desativar' : 'Ativar'}
              </button>
              <button onClick={() => void remove(p)} className="rounded-lg border border-zinc-200 p-1.5 text-zinc-400 hover:text-red-500 dark:border-zinc-700" title="Excluir">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {products?.length === 0 && <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">Nenhum produto de escrita ainda.</p>}
        {products === null && !error && <p className="text-sm text-zinc-500">Carregando…</p>}
      </div>

      {open && <NewProduct conns={conns} onClose={() => setOpen(false)} onSaved={load} />}
    </div>
  )
}

function NewProduct({ conns, onClose, onSaved }: { conns: ConnectionInfo[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [connectionId, setConnectionId] = useState(conns[0]?.id ?? '')
  const [schema, setSchema] = useState('public')
  const [table, setTable] = useState('')
  const [cols, setCols] = useState<Column[]>([{ col: '', type: 'text', required: false }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setCol = (i: number, patch: Partial<Column>) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const inp = 'rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'

  async function save() {
    const columns = cols.filter((c) => c.col.trim()).map((c) => ({ col: c.col.trim(), type: c.type, required: c.required }))
    if (!name.trim() || !connectionId || !table.trim() || !columns.length) { setError('Preencha nome, conexão, tabela e ao menos uma coluna.'); return }
    setBusy(true); setError(null)
    try {
      await api('/api/v1/write-products', { method: 'POST', body: JSON.stringify({ name: name.trim(), connectionId, schema: schema.trim() || 'public', table: table.trim(), columns }) })
      onSaved(); onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao criar.'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Novo produto de escrita</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        <div className="grid gap-3">
          <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${inp} w-full`} placeholder="Registrar ocorrência" />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Conexão gravável</span>
              <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className={`${inp} w-full`}>
                {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Schema</span>
              <input value={schema} onChange={(e) => setSchema(e.target.value)} className={`${inp} w-full`} placeholder="public" />
            </label>
            <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Tabela</span>
              <input value={table} onChange={(e) => setTable(e.target.value)} className={`${inp} w-full`} placeholder="ocorrencias" />
            </label>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-zinc-500">Colunas expostas (o dev só pode escrever nestas)</span>
              <button onClick={() => setCols((c) => [...c, { col: '', type: 'text', required: false }])} className="text-xs text-accent">+ coluna</button>
            </div>
            <div className="grid gap-1.5">
              {cols.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={c.col} onChange={(e) => setCol(i, { col: e.target.value })} className={`${inp} flex-1`} placeholder="nome_da_coluna" />
                  <select value={c.type} onChange={(e) => setCol(i, { type: e.target.value as Column['type'] })} className={inp}>
                    <option value="text">texto</option><option value="number">número</option><option value="bool">booleano</option><option value="date">data</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs text-zinc-500">
                    <input type="checkbox" checked={c.required} onChange={(e) => setCol(i, { required: e.target.checked })} /> obrig.
                  </label>
                  <button onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-500"><X size={14} /></button>
                </div>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={save} disabled={busy} className="mt-1 flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />} Criar produto
          </button>
        </div>
      </div>
    </div>
  )
}
