// Construtor de API de dados: leitura de um conjunto (GET /p/{slug}) ou escrita
// num banco de origem (/w/{slug}). Escrita nasce PENDENTE e só vai ao ar depois
// que um admin aprova, na Visão geral.
import { useEffect, useState } from 'react'
import { Webhook, Loader2, X, Check } from 'lucide-react'
import type { ApiProduct, ApiProductColumn, ApiWriteOp, DatasetSummary, QueryFilter } from '@datahub/shared'
import { api } from '@/lib/api'
import { Dialog, Field, INPUT, BTN_PRIMARY, BTN_SECONDARY, errMsg } from './shared'

// Operações de escrita e o verbo HTTP de cada uma.
const WRITE_OPS: { op: ApiWriteOp; label: string; hint: string }[] = [
  { op: 'insert', label: 'Criar', hint: 'POST · adiciona linha' },
  { op: 'update', label: 'Atualizar', hint: 'PUT · exige filtro' },
  { op: 'delete', label: 'Remover', hint: 'DELETE · exige filtro' },
]
const TYPE_OPTS: { v: ApiProductColumn['type']; label: string }[] = [
  { v: 'text', label: 'texto' }, { v: 'number', label: 'número' }, { v: 'bool', label: 'booleano' }, { v: 'date', label: 'data' },
]

export default function ApiBuilder({ kind, initial, onClose, onSaved }: {
  kind: 'read' | 'write'
  initial: ApiProduct | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial
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
  const [conns, setConns] = useState<{ id: string; name: string }[] | null>(null)
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
    if (kind === 'read') {
      api<{ datasets: DatasetSummary[] }>('/api/v1/datasets').then((r) => setDatasets(r.datasets.filter((d) => d.lastSyncAt))).catch(() => {})
    } else {
      api<{ connections: { id: string; name: string }[] }>('/api/v1/products/writable-connections')
        .then((r) => setConns(r.connections)).catch(() => setConns([]))
    }
  }, [kind])

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
      onSaved()
      if (r.status === 'pending') {
        setNote('Enviada para aprovação de um administrador. Ela vai ao ar depois de aprovada.')
        setBusy(false)
        return
      }
      onClose()
    } catch (e) { setError(errMsg(e, 'Falha ao salvar.')); setBusy(false) }
  }

  const titulo = kind === 'read'
    ? (isEdit ? 'Editar API de leitura' : 'Nova API de leitura')
    : (isEdit ? 'Editar API de escrita' : 'Nova API de escrita')
  const sub = kind === 'read'
    ? 'Expõe um conjunto do Data Hub em GET /p/{nome}, com paginação e filtros fixos.'
    : 'Grava num banco de origem. Passa por aprovação de um administrador antes de ir ao ar.'

  return (
    <Dialog icon={Webhook} title={titulo} sub={sub} width={560} onClose={onClose}
      footer={note ? (
        <button onClick={onClose} className={BTN_PRIMARY}><Check size={13} strokeWidth={2.4} /> Entendi</button>
      ) : (
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancelar</button>
          <button onClick={() => void save()} disabled={busy || !name.trim()} className={BTN_PRIMARY}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.4} />}
            {isEdit ? 'Salvar' : kind === 'write' ? 'Enviar para aprovação' : 'Criar API'}
          </button>
        </>
      )}>
      <div className="grid gap-3">
        {/* Operação de escrita (define o verbo HTTP) */}
        {kind === 'write' && (
          <Field label="Operação" group>
            <div className="grid grid-cols-3 gap-2">
              {WRITE_OPS.map((o) => (
                <button key={o.op} type="button" onClick={() => setWriteOp(o.op)}
                  className={`rounded-lg border px-2 py-1.5 text-left text-[12px] ${writeOp === o.op
                    ? 'border-accent bg-accent-soft text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                    : 'border-zinc-200 text-zinc-500 dark:border-zinc-700'}`}>
                  <span className="block font-semibold">{o.label}</span>
                  <span className="block font-mono text-[10px] opacity-80">{o.hint}</span>
                </button>
              ))}
            </div>
            {writeOp === 'update' && (
              <label className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                <input type="checkbox" checked={useMethodPatch} onChange={(e) => setUseMethodPatch(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
                Usar <code className="font-mono">PATCH</code> em vez de <code className="font-mono">PUT</code>
              </label>
            )}
          </Field>
        )}

        <Field label="Nome">
          <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} autoFocus
            placeholder={kind === 'read' ? 'Clientes ativos' : 'Registrar ocorrência'} />
        </Field>

        {kind === 'read' ? (
          <>
            <Field label="Conjunto">
              <select value={datasetSlug} onChange={(e) => setDatasetSlug(e.target.value)} className={INPUT}>
                <option value="">— escolha —</option>
                {datasets.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Paginação">
                <select value={pagination} onChange={(e) => setPagination(e.target.value as 'page' | 'offset')} className={INPUT}>
                  <option value="offset">offset / limit</option><option value="page">page / size</option>
                </select>
              </Field>
              <Field label="Limite padrão">
                <input type="number" value={defaultLimit} onChange={(e) => setDefaultLimit(e.target.value)} className={INPUT} />
              </Field>
              <Field label="Limite máximo">
                <input type="number" value={maxLimit} onChange={(e) => setMaxLimit(e.target.value)} className={INPUT} />
              </Field>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">Filtros fixos (opcional)</span>
                <button type="button" onClick={() => setReadFilters((f) => [...f, { field: '', op: '=', value: '' }])} className="text-[11.5px] font-medium text-info hover:underline dark:text-info-dark">+ filtro</button>
              </div>
              <div className="grid gap-1.5">
                {readFilters.map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={f.field} onChange={(e) => setReadFilters((fs) => fs.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} className={`${INPUT} flex-1`} placeholder="campo" />
                    <select value={f.op} onChange={(e) => setReadFilters((fs) => fs.map((x, j) => j === i ? { ...x, op: e.target.value as QueryFilter['op'] } : x))} className={`${INPUT} max-w-[90px]`}>
                      {['=', '!=', '>', '<', '>=', '<=', 'contains'].map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                    <input value={String(f.value ?? '')} onChange={(e) => setReadFilters((fs) => fs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} className={`${INPUT} flex-1`} placeholder="valor" />
                    <button type="button" onClick={() => setReadFilters((fs) => fs.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-crit"><X size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            {conns?.length === 0 && (
              <p className="rounded-lg border border-warn/40 bg-warn-soft p-2 text-[11px] text-zinc-700 dark:bg-warn/10 dark:text-zinc-300">
                Nenhuma conexão gravável. Um administrador precisa marcar uma conexão como "gravável" em Conexões.
              </p>
            )}
            <div className="grid grid-cols-3 gap-2">
              <Field label="Conexão gravável">
                <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className={INPUT}>
                  <option value="">— escolha —</option>
                  {(conns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Schema">
                <input value={schema} onChange={(e) => setSchema(e.target.value)} className={INPUT} placeholder="public" />
              </Field>
              <Field label="Tabela">
                <input value={table} onChange={(e) => setTable(e.target.value)} className={INPUT} placeholder="ocorrencias" />
              </Field>
            </div>
            {needsBody && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">
                    {writeOp === 'update' ? 'Campos atualizáveis (set)' : 'Campos que o consumidor envia'}
                  </span>
                  <button type="button" onClick={() => setColumns((c) => [...c, { col: '', type: 'text', required: false }])} className="text-[11.5px] font-medium text-info hover:underline dark:text-info-dark">+ campo</button>
                </div>
                <div className="grid gap-1.5">
                  {columns.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input value={c.col} onChange={(e) => setCol(i, { col: e.target.value })} className={`${INPUT} flex-1`} placeholder="nome_da_coluna" />
                      <select value={c.type} onChange={(e) => setCol(i, { type: e.target.value as ApiProductColumn['type'] })} className={`${INPUT} max-w-[110px]`}>
                        {TYPE_OPTS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                      </select>
                      {writeOp === 'insert' && (
                        <label className="flex items-center gap-1 text-[11px] text-zinc-500">
                          <input type="checkbox" checked={c.required} onChange={(e) => setCol(i, { required: e.target.checked })} className="h-3.5 w-3.5 accent-accent" /> obrig.
                        </label>
                      )}
                      <button type="button" onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-crit"><X size={14} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Chaves do WHERE + teto de linhas (update/delete) */}
            {needsKeys && (
              <div className="rounded-lg border border-crit/30 p-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11.5px] font-medium text-zinc-700 dark:text-zinc-300">Filtros permitidos (where) — obrigatório</span>
                  <button type="button" onClick={() => setKeyColumns((c) => [...c, { col: '', type: 'text', required: true }])} className="text-[11.5px] font-medium text-info hover:underline dark:text-info-dark">+ chave</button>
                </div>
                <p className="mb-1.5 text-[11px] text-zinc-500">
                  Sem <code className="font-mono">where</code> a chamada é recusada — nunca varre a tabela. Só estas colunas filtram; prefira uma chave única (ex.: <code className="font-mono">id</code>).
                </p>
                <div className="grid gap-1.5">
                  {keyColumns.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input value={c.col} onChange={(e) => setKey(i, { col: e.target.value })} className={`${INPUT} flex-1`} placeholder="id" />
                      <select value={c.type} onChange={(e) => setKey(i, { type: e.target.value as ApiProductColumn['type'] })} className={`${INPUT} max-w-[110px]`}>
                        {TYPE_OPTS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                      </select>
                      <button type="button" onClick={() => setKeyColumns((cs) => cs.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-crit"><X size={14} /></button>
                    </div>
                  ))}
                </div>
                <div className="mt-2">
                  <Field label="Teto de linhas afetadas" hint="Roda em transação: se a chamada afetar mais linhas que isso, é desfeita. Vazio = sem teto.">
                    <input type="number" min={1} value={maxAffected} onChange={(e) => setMaxAffected(e.target.value)} className={INPUT} placeholder="1" />
                  </Field>
                </div>
              </div>
            )}
          </>
        )}
        {error && <p className="rounded-lg bg-crit-soft px-2.5 py-2 text-[11.5px] text-crit dark:bg-crit/15 dark:text-crit-dark">{error}</p>}
        {note && <p className="rounded-lg bg-warn-soft px-2.5 py-2 text-[11.5px] text-zinc-700 dark:bg-warn/10 dark:text-zinc-300">{note}</p>}
      </div>
    </Dialog>
  )
}
