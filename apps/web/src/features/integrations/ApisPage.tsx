// Construtor de APIs (self-service do dev). Uma página onde o desenvolvedor cria
// suas APIs escolhendo o método: GET (leitura de um dataset, com paginação
// page/offset + filtros) ou POST (escrita, com body). Escrita nasce PENDENTE e
// o admin aprova aqui mesmo (seção "Pendentes"). Testar + snippet prontos.
import { useEffect, useMemo, useState } from 'react'
import { Webhook, Plus, Trash2, RefreshCw, Loader2, X, Check, Copy, Play, Pencil, Clock } from 'lucide-react'
import type { ApiProduct, ApiProductColumn, ApiWriteOp, DatasetSummary, QueryFilter } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'

// Operações de escrita e o verbo HTTP de cada uma.
const WRITE_OPS: { op: ApiWriteOp; label: string; hint: string; method: string }[] = [
  { op: 'insert', label: 'Criar', hint: 'INSERT — adiciona linha', method: 'POST' },
  { op: 'update', label: 'Atualizar', hint: 'UPDATE — exige filtro', method: 'PUT' },
  { op: 'delete', label: 'Remover', hint: 'DELETE — exige filtro', method: 'DELETE' },
]
const METHOD_CLS: Record<string, string> = {
  GET: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400',
  POST: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
  PUT: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  PATCH: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  DELETE: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400',
}

const STATUS: Record<ApiProduct['status'], { label: string; cls: string }> = {
  active: { label: 'Ativo', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' },
  pending: { label: 'Pendente', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' },
  rejected: { label: 'Recusado', cls: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400' },
}

export default function ApisPage() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = !!user?.roles.includes('admin')
  const confirm = useConfirm()
  const [products, setProducts] = useState<ApiProduct[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ApiProduct | 'new' | null>(null)

  async function load() {
    setError(null)
    try { setProducts((await api<{ products: ApiProduct[] }>('/api/v1/products')).products) }
    catch (e) { setError(e instanceof Error ? e.message : 'Falha ao carregar.') }
  }
  useEffect(() => { void load() }, [])

  const pending = useMemo(() => (products ?? []).filter((p) => p.kind === 'write' && p.status === 'pending'), [products])

  async function review(p: ApiProduct, action: 'approve' | 'reject') {
    if (action === 'reject' && !(await confirm({ title: 'Recusar API', message: `Recusar a API de escrita "${p.name}"?`, danger: true, confirmLabel: 'Recusar' }))) return
    await api(`/api/v1/products/${p.id}/${action}`, { method: 'POST' }).then(load).catch((e) => setError(e instanceof Error ? e.message : 'Falha.'))
  }
  async function remove(p: ApiProduct) {
    if (!(await confirm({ title: 'Excluir API', message: `Excluir a API "${p.name}"?`, danger: true, confirmLabel: 'Excluir' }))) return
    await api(`/api/v1/products/${p.id}`, { method: 'DELETE' }).then(load).catch((e) => setError(e instanceof Error ? e.message : 'Falha.'))
  }
  async function toggle(p: ApiProduct) {
    await api(`/api/v1/products/${p.id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled: !p.enabled }) }).then(load).catch(() => {})
  }

  return (
    <div className="mx-auto min-w-0 max-w-[1600px]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
            <Webhook size={22} className="text-accent" /> APIs
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Monte suas APIs de <strong>leitura</strong> (GET) e <strong>escrita</strong> (POST). As de escrita passam por aprovação de um admin antes de ir ao ar.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditing('new')} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover">
            <Plus size={15} /> Nova API
          </button>
          <button onClick={load} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            <RefreshCw size={14} /> Atualizar
          </button>
        </div>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      {/* Fila de aprovação (admin) */}
      {isAdmin && pending.length > 0 && (
        <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/20">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
            <Clock size={15} /> {pending.length} API(s) de escrita aguardando sua aprovação
          </p>
          <div className="grid gap-2">
            {pending.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-lg border border-amber-200 bg-white p-3 dark:border-amber-900 dark:bg-zinc-900">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${METHOD_CLS[p.method] ?? ''}`}>{p.method}</span>
                    {p.name} <span className="text-xs font-normal text-zinc-400">por {p.ownerEmail}</span>
                  </p>
                  <p className="truncate font-mono text-xs text-zinc-500">
                    {p.method} /w/{p.slug} → {p.connectionId}: {p.schemaName}.{p.tableName}
                    {p.writeOp !== 'delete' && ` · ${p.columns?.length ?? 0} campo(s)`}
                    {p.writeOp !== 'insert' && ` · filtro por ${(p.keyColumns ?? []).map((k) => k.col).join('/') || '—'}`}
                    {p.maxAffected != null && ` · teto ${p.maxAffected} linha(s)`}
                  </p>
                </div>
                <button onClick={() => void review(p, 'approve')} className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"><Check size={13} /> Aprovar</button>
                <button onClick={() => void review(p, 'reject')} className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-600 hover:text-red-600 dark:border-zinc-700">Recusar</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-3">
        {products?.map((p) => (
          <ProductCard key={p.id} p={p} isAdmin={isAdmin} ownEmail={user?.email ?? ''} onEdit={() => setEditing(p)} onDelete={() => remove(p)} onToggle={() => toggle(p)} />
        ))}
        {products?.length === 0 && <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">Nenhuma API ainda. Clique em "Nova API" para começar.</p>}
        {products === null && !error && <p className="text-sm text-zinc-500">Carregando…</p>}
      </div>

      {editing && <ApiBuilder initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  )
}

function ProductCard({ p, isAdmin, ownEmail, onEdit, onDelete, onToggle }: {
  p: ApiProduct; isAdmin: boolean; ownEmail: string; onEdit: () => void; onDelete: () => void; onToggle: () => void
}) {
  const canManage = isAdmin || p.ownerEmail === ownEmail
  const [showSnippet, setShowSnippet] = useState(false)
  const [testOut, setTestOut] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const origin = window.location.origin
  const isGet = p.method === 'GET'
  const url = isGet ? `${origin}/api/public/v1/p/${p.slug}` : `${origin}/api/public/v1/w/${p.slug}`
  const pag = p.pagination === 'page' ? '&page=1' : '&offset=0'
  // Exemplo de valor por tipo, para snippet e teste.
  const sample = (c: ApiProductColumn) => (c.type === 'number' ? 0 : c.type === 'bool' ? true : c.type === 'date' ? '2026-01-31' : 'exemplo')
  const jsonOf = (cols: ApiProductColumn[]) => `{ ${cols.map((c) => `"${c.col}": ${JSON.stringify(sample(c))}`).join(', ')} }`
  const setCols = p.columns ?? []
  const keyCols = p.keyColumns ?? []
  // O corpo depende da operação: insert = valores planos; update = {set, where}; delete = {where}.
  const bodyJson = p.writeOp === 'update'
    ? `{ "set": ${jsonOf(setCols)}, "where": ${jsonOf(keyCols)} }`
    : p.writeOp === 'delete' ? `{ "where": ${jsonOf(keyCols)} }` : jsonOf(setCols)
  const snippet = isGet
    ? `curl "${url}?token=SEU_TOKEN${pag}"`
    : `curl -X ${p.method} "${url}?token=SEU_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${bodyJson}'`

  async function runTest() {
    setTesting(true); setTestOut(null)
    try {
      const objOf = (cols: ApiProductColumn[]) => Object.fromEntries(cols.map((c) => [c.col, sample(c)]))
      const body = isGet ? {}
        : p.writeOp === 'update' ? { set: objOf(setCols), where: objOf(keyCols) }
        : p.writeOp === 'delete' ? { where: objOf(keyCols) }
        : { body: objOf(setCols) }
      const r = await api<Record<string, unknown>>(`/api/v1/products/${p.id}/test`, { method: 'POST', body: JSON.stringify(body) })
      setTestOut(JSON.stringify(r, null, 2))
    } catch (e) { setTestOut(e instanceof Error ? e.message : 'Falha no teste.') }
    finally { setTesting(false) }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-3">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${METHOD_CLS[p.method] ?? ''}`}>{p.method}</span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-medium">
            {p.name}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
          </p>
          <p className="truncate font-mono text-xs text-zinc-500">
            {isGet
              ? `GET /p/${p.slug} → ${p.datasetSlug} · ${p.pagination} · limite ${p.defaultLimit}/${p.maxLimit}`
              : `${p.method} /w/${p.slug} → ${p.connectionId}: ${p.schemaName}.${p.tableName}`
                + (p.writeOp !== 'delete' ? ` · ${setCols.length} campo(s)` : '')
                + (p.writeOp !== 'insert' ? ` · filtro: ${keyCols.map((k) => k.col).join('/') || '—'}` : '')
                + (p.maxAffected != null ? ` · teto ${p.maxAffected}` : '')}
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-1">
            <button onClick={() => setShowSnippet((v) => !v)} className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:text-accent dark:border-zinc-700">Snippet</button>
            <button onClick={runTest} disabled={testing || p.status !== 'active'} title={p.status !== 'active' ? 'Disponível após ativa' : 'Testar'}
              className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:text-accent disabled:opacity-40 dark:border-zinc-700">
              {testing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Testar
            </button>
            <button onClick={onToggle} className={`rounded-lg border px-2 py-1 text-xs ${p.enabled ? 'border-zinc-200 text-zinc-600 dark:border-zinc-700' : 'border-accent text-secondary'}`}>{p.enabled ? 'On' : 'Off'}</button>
            <button onClick={onEdit} className="rounded-lg border border-zinc-200 p-1.5 text-zinc-400 hover:text-accent dark:border-zinc-700" title="Editar"><Pencil size={13} /></button>
            <button onClick={onDelete} className="rounded-lg border border-zinc-200 p-1.5 text-zinc-400 hover:text-red-500 dark:border-zinc-700" title="Excluir"><Trash2 size={13} /></button>
          </div>
        )}
      </div>
      {showSnippet && (
        <div className="mt-3 flex items-start gap-2">
          <pre className="flex-1 overflow-x-auto rounded-lg bg-zinc-50 p-3 text-[11px] dark:bg-zinc-950"><code>{snippet}</code></pre>
          <button onClick={() => navigator.clipboard.writeText(snippet)} className="rounded-lg border border-zinc-200 p-2 text-zinc-500 hover:text-accent dark:border-zinc-700"><Copy size={13} /></button>
        </div>
      )}
      {testOut && <pre className="mt-3 max-h-52 overflow-auto rounded-lg bg-zinc-50 p-3 text-[11px] dark:bg-zinc-950"><code>{testOut}</code></pre>}
    </div>
  )
}

// ── Construtor (nova API / editar) ──────────────────────────────
function ApiBuilder({ initial, onClose, onSaved }: { initial: ApiProduct | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!initial
  const [kind, setKind] = useState<'read' | 'write'>(initial?.kind ?? 'read')
  const [name, setName] = useState(initial?.name ?? '')
  // Leitura
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [datasetSlug, setDatasetSlug] = useState(initial?.datasetSlug ?? '')
  const [pagination, setPagination] = useState<'page' | 'offset'>(initial?.pagination ?? 'offset')
  const [defaultLimit, setDefaultLimit] = useState(String(initial?.defaultLimit ?? 100))
  const [maxLimit, setMaxLimit] = useState(String(initial?.maxLimit ?? 10000))
  const [readFilters, setReadFilters] = useState<QueryFilter[]>(initial?.readFilters ?? [])
  // Escrita
  const [writeOp, setWriteOp] = useState<ApiWriteOp>(initial?.writeOp ?? 'insert')
  const [conns, setConns] = useState<{ id: string; name: string }[]>([])
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? '')
  const [schema, setSchema] = useState(initial?.schemaName ?? 'public')
  const [table, setTable] = useState(initial?.tableName ?? '')
  const [columns, setColumns] = useState<ApiProductColumn[]>(initial?.columns ?? [{ col: '', type: 'text', required: false }])
  const [keyColumns, setKeyColumns] = useState<ApiProductColumn[]>(initial?.keyColumns ?? [{ col: '', type: 'text', required: true }])
  const [maxAffected, setMaxAffected] = useState(initial?.maxAffected != null ? String(initial.maxAffected) : '1')
  const [useMethodPatch, setUseMethodPatch] = useState(initial?.method === 'PATCH')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets').then((r) => setDatasets(r.datasets.filter((d) => d.lastSyncAt))).catch(() => {})
    api<{ connections: { id: string; name: string }[] }>('/api/v1/products/writable-connections').then((r) => setConns(r.connections)).catch(() => {})
  }, [])

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'
  const setCol = (i: number, patch: Partial<ApiProductColumn>) => setColumns((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const setKey = (i: number, patch: Partial<ApiProductColumn>) => setKeyColumns((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const needsKeys = writeOp !== 'insert'   // update/delete exigem WHERE
  const needsBody = writeOp !== 'delete'   // insert/update precisam de colunas

  async function save() {
    setBusy(true); setError(null); setNote(null)
    const payload: Record<string, unknown> = kind === 'read'
      ? { kind, name: name.trim(), datasetSlug, pagination, defaultLimit: Number(defaultLimit) || 100, maxLimit: Number(maxLimit) || 10000, readFilters }
      : {
          kind, name: name.trim(), writeOp,
          method: writeOp === 'update' && useMethodPatch ? 'PATCH' : undefined,
          connectionId, schema: schema.trim() || 'public', table: table.trim(),
          columns: needsBody ? columns.filter((c) => c.col.trim()) : [],
          keyColumns: needsKeys ? keyColumns.filter((c) => c.col.trim()) : [],
          maxAffected: needsKeys && maxAffected !== '' ? Number(maxAffected) : null,
        }
    try {
      const r = await api<{ status: string }>(isEdit ? `/api/v1/products/${initial!.id}` : '/api/v1/products', { method: isEdit ? 'PATCH' : 'POST', body: JSON.stringify(payload) })
      if (r.status === 'pending') { setNote('API de escrita enviada para aprovação de um admin. Ela vai ao ar depois de aprovada.'); onSaved(); return }
      onSaved(); onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao salvar.'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white p-3.5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{isEdit ? 'Editar API' : 'Nova API'}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>

        <div className="grid gap-3 overflow-y-auto pr-1">
          {/* Método */}
          <div>
            <span className="mb-1 block text-xs text-zinc-500">Método</span>
            <div className="flex gap-2">
              <button onClick={() => setKind('read')} disabled={isEdit} className={`flex-1 rounded-lg border px-3 py-2 text-sm ${kind === 'read' ? 'border-sky-400 bg-sky-50 text-sky-700 dark:bg-sky-950/30' : 'border-zinc-200 text-zinc-500 dark:border-zinc-700'} disabled:opacity-60`}>GET · leitura</button>
              <button onClick={() => setKind('write')} disabled={isEdit} className={`flex-1 rounded-lg border px-3 py-2 text-sm ${kind === 'write' ? 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/30' : 'border-zinc-200 text-zinc-500 dark:border-zinc-700'} disabled:opacity-60`}>Escrita</button>
            </div>
            {kind === 'write' && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-500">Escrita passa por aprovação de um admin antes de ir ao ar.</p>}
          </div>

          {/* Operação de escrita (define o verbo HTTP) */}
          {kind === 'write' && (
            <div>
              <span className="mb-1 block text-xs text-zinc-500">Operação</span>
              <div className="grid grid-cols-3 gap-2">
                {WRITE_OPS.map((o) => (
                  <button key={o.op} onClick={() => setWriteOp(o.op)}
                    className={`rounded-lg border px-2 py-2 text-left text-xs ${writeOp === o.op ? 'border-accent bg-accent/10 text-accent' : 'border-zinc-200 text-zinc-500 dark:border-zinc-700'}`}>
                    <span className="block font-semibold">{o.label}</span>
                    <span className="block text-[10px] opacity-80">{o.hint}</span>
                  </button>
                ))}
              </div>
              {writeOp === 'update' && (
                <label className="mt-1.5 flex items-center gap-2 text-[11px] text-zinc-500">
                  <input type="checkbox" checked={useMethodPatch} onChange={(e) => setUseMethodPatch(e.target.checked)} />
                  Usar <code className="font-mono">PATCH</code> em vez de <code className="font-mono">PUT</code>
                </label>
              )}
              {needsKeys && (
                <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                  {writeOp === 'delete' ? 'DELETE' : 'UPDATE'} exige filtro: sem <code className="font-mono">where</code> a operação é recusada (nunca varre a tabela).
                </p>
              )}
            </div>
          )}

          <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inp} placeholder={kind === 'read' ? 'Clientes ativos' : 'Registrar ocorrência'} />
          </label>

          {kind === 'read' ? (
            <>
              <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Dataset (leitura)</span>
                <select value={datasetSlug} onChange={(e) => setDatasetSlug(e.target.value)} className={inp}>
                  <option value="">— escolha —</option>
                  {datasets.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Paginação</span>
                  <select value={pagination} onChange={(e) => setPagination(e.target.value as 'page' | 'offset')} className={inp}>
                    <option value="offset">offset / limit</option><option value="page">page / size</option>
                  </select>
                </label>
                <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Limite padrão</span>
                  <input type="number" value={defaultLimit} onChange={(e) => setDefaultLimit(e.target.value)} className={inp} />
                </label>
                <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Limite máx.</span>
                  <input type="number" value={maxLimit} onChange={(e) => setMaxLimit(e.target.value)} className={inp} />
                </label>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Filtros fixos (opcional)</span>
                  <button onClick={() => setReadFilters((f) => [...f, { field: '', op: '=', value: '' }])} className="text-xs text-accent">+ filtro</button>
                </div>
                <div className="grid gap-1.5">
                  {readFilters.map((f, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input value={f.field} onChange={(e) => setReadFilters((fs) => fs.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} className={`${inp} flex-1`} placeholder="campo" />
                      <select value={f.op} onChange={(e) => setReadFilters((fs) => fs.map((x, j) => j === i ? { ...x, op: e.target.value as QueryFilter['op'] } : x))} className={inp + ' max-w-[90px]'}>
                        {['=', '!=', '>', '<', '>=', '<=', 'contains'].map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                      <input value={String(f.value ?? '')} onChange={(e) => setReadFilters((fs) => fs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} className={`${inp} flex-1`} placeholder="valor" />
                      <button onClick={() => setReadFilters((fs) => fs.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-500"><X size={14} /></button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              {conns.length === 0 && <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/30">Nenhuma conexão gravável. Um admin precisa marcar uma conexão como "gravável" em Conexões.</p>}
              <div className="grid grid-cols-3 gap-2">
                <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Conexão gravável</span>
                  <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className={inp}>
                    <option value="">— escolha —</option>
                    {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Schema</span>
                  <input value={schema} onChange={(e) => setSchema(e.target.value)} className={inp} placeholder="public" />
                </label>
                <label className="text-sm"><span className="mb-1 block text-xs text-zinc-500">Tabela</span>
                  <input value={table} onChange={(e) => setTable(e.target.value)} className={inp} placeholder="ocorrencias" />
                </label>
              </div>
              {needsBody && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs text-zinc-500">
                      {writeOp === 'update' ? 'Campos atualizáveis (set)' : 'Body (colunas que o consumidor pode enviar)'}
                    </span>
                    <button onClick={() => setColumns((c) => [...c, { col: '', type: 'text', required: false }])} className="text-xs text-accent">+ campo</button>
                  </div>
                  <div className="grid gap-1.5">
                    {columns.map((c, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input value={c.col} onChange={(e) => setCol(i, { col: e.target.value })} className={`${inp} flex-1`} placeholder="nome_da_coluna" />
                        <select value={c.type} onChange={(e) => setCol(i, { type: e.target.value as ApiProductColumn['type'] })} className={inp + ' max-w-[110px]'}>
                          <option value="text">texto</option><option value="number">número</option><option value="bool">booleano</option><option value="date">data</option>
                        </select>
                        {writeOp === 'insert' && (
                          <label className="flex items-center gap-1 text-xs text-zinc-500"><input type="checkbox" checked={c.required} onChange={(e) => setCol(i, { required: e.target.checked })} /> obrig.</label>
                        )}
                        <button onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-500"><X size={14} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Chaves do WHERE + teto de linhas (update/delete) */}
              {needsKeys && (
                <div className="rounded-lg border border-red-200 p-2.5 dark:border-red-900/60">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Filtros permitidos (where) — obrigatório</span>
                    <button onClick={() => setKeyColumns((c) => [...c, { col: '', type: 'text', required: true }])} className="text-xs text-accent">+ chave</button>
                  </div>
                  <p className="mb-1.5 text-[11px] text-zinc-500">Só estas colunas podem filtrar. Prefira uma chave única (ex.: <code className="font-mono">id</code>).</p>
                  <div className="grid gap-1.5">
                    {keyColumns.map((c, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input value={c.col} onChange={(e) => setKey(i, { col: e.target.value })} className={`${inp} flex-1`} placeholder="id" />
                        <select value={c.type} onChange={(e) => setKey(i, { type: e.target.value as ApiProductColumn['type'] })} className={inp + ' max-w-[110px]'}>
                          <option value="text">texto</option><option value="number">número</option><option value="bool">booleano</option><option value="date">data</option>
                        </select>
                        <button onClick={() => setKeyColumns((cs) => cs.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-500"><X size={14} /></button>
                      </div>
                    ))}
                  </div>
                  <label className="mt-2 block text-sm">
                    <span className="mb-1 block text-xs text-zinc-500">Teto de linhas afetadas (vazio = sem teto)</span>
                    <input type="number" min={1} value={maxAffected} onChange={(e) => setMaxAffected(e.target.value)} className={inp} placeholder="1" />
                    <span className="mt-1 block text-[11px] text-zinc-500">Roda em transação: se a chamada afetar mais linhas que isso, é revertida (rollback).</span>
                  </label>
                </div>
              )}
            </>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
          {note && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-700 dark:bg-amber-950/30">{note}</p>}
        </div>

        <button onClick={save} disabled={busy} className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
          {busy && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Salvar' : (kind === 'write' ? 'Enviar para aprovação' : 'Criar API')}
        </button>
      </div>
    </div>
  )
}
