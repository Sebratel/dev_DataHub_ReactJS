// Catálogo único de tudo o que o Data Hub serve por fora:
//   Leitura          GET /p/{slug}   um conjunto do lake, paginado
//   Escrita          /w/{slug}       grava num banco de origem (com aprovação)
//   Serviço interno  /gw/{slug}/…    repassa para um sistema da casa
// Para quem consome, as três são "uma API com endereço e token" — por isso
// moram numa tabela só. Clicar na linha abre endereço, exemplo e teste.
import { Fragment, useMemo, useState } from 'react'
import { Webhook, Pencil, Trash2, Power, Copy, Check, Play, Loader2, ChevronRight, Database, PenLine, Radio } from 'lucide-react'
import type { ApiProduct, ApiProductColumn, GatewayUpstream } from '@datahub/shared'
import type { LucideIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { Toolbar, SearchInput, FilterChips } from '@/components/ui/Page'
import { DataGrid, Th, Tr, Td } from '@/components/ui/DataGrid'
import { MethodChip, ICON_BTN, ICON_BTN_DANGER, errMsg } from './shared'
import { AUTH_LABEL } from './UpstreamDialog'

export type ApiKind = 'read' | 'write' | 'service'

export interface CatalogItem {
  key: string
  kind: ApiKind
  name: string
  /** Caminho público, sem o prefixo /api/public/v1. */
  path: string
  methods: string[]
  target: string
  status: 'active' | 'pending' | 'rejected'
  enabled: boolean
  owner: string
  product?: ApiProduct
  upstream?: GatewayUpstream
}

export const KIND: Record<ApiKind, { label: string; icon: LucideIcon }> = {
  read: { label: 'Leitura', icon: Database },
  write: { label: 'Escrita', icon: PenLine },
  service: { label: 'Serviço interno', icon: Radio },
}

export function toItems(products: ApiProduct[], upstreams: GatewayUpstream[]): CatalogItem[] {
  return [
    ...products.map((p): CatalogItem => ({
      key: `p:${p.id}`,
      kind: p.kind === 'write' ? 'write' : 'read',
      name: p.name,
      path: p.kind === 'write' ? `/w/${p.slug}` : `/p/${p.slug}`,
      methods: [p.method],
      target: p.kind === 'write' ? `${p.connectionId}: ${p.schemaName}.${p.tableName}` : `conjunto ${p.datasetSlug}`,
      status: p.status,
      enabled: p.enabled,
      owner: p.ownerEmail,
      product: p,
    })),
    ...upstreams.map((u): CatalogItem => ({
      key: `u:${u.id}`,
      kind: 'service',
      name: u.name,
      path: `/gw/${u.slug}`,
      methods: u.methods,
      target: u.baseUrl,
      status: u.status,
      enabled: u.enabled,
      owner: u.ownerEmail,
      upstream: u,
    })),
  ]
}

export const isLive = (it: CatalogItem) => it.status === 'active' && it.enabled

export function StatePill({ it }: { it: CatalogItem }) {
  if (it.status === 'pending') return <Pill tone="warn">pendente</Pill>
  if (it.status === 'rejected') return <Pill tone="crit">recusada</Pill>
  return it.enabled ? <Pill tone="ok" dot>no ar</Pill> : <Pill>pausada</Pill>
}

type Filter = 'all' | ApiKind

export default function ApisTab({ items, isAdmin, me, onNew, onEdit, onToggle, onDelete }: {
  items: CatalogItem[]
  isAdmin: boolean
  me: string
  onNew: () => void
  onEdit: (it: CatalogItem) => void
  onToggle: (it: CatalogItem) => void
  onDelete: (it: CatalogItem) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const count = (k: ApiKind) => items.filter((i) => i.kind === k).length
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase()
    return items.filter((i) => (filter === 'all' || i.kind === filter)
      && (!term || `${i.name} ${i.path} ${i.target} ${i.owner}`.toLowerCase().includes(term)))
  }, [items, filter, q])

  return (
    <>
      <Toolbar>
        <FilterChips<Filter> value={filter} onChange={setFilter} options={[
          { key: 'all', label: 'Todas', count: items.length },
          { key: 'read', label: 'Leitura', count: count('read'), icon: Database },
          { key: 'write', label: 'Escrita', count: count('write'), icon: PenLine },
          { key: 'service', label: 'Serviços internos', count: count('service'), icon: Radio },
        ]} />
        <SearchInput value={q} onChange={setQ} placeholder="Buscar por nome, endereço ou dono" />
      </Toolbar>

      <Card>
        <CardHead icon={Webhook} title="APIs" sub={`${shown.length} de ${items.length}`}>
          <span className="text-[10.5px] text-zinc-400">clique na linha para ver endereço, exemplo e teste</span>
        </CardHead>
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <Webhook size={26} strokeWidth={1.2} className="mx-auto mb-2 text-zinc-300 dark:text-zinc-700" />
            <p className="text-[12px] text-zinc-500">Nenhuma API ainda.</p>
            <button onClick={onNew} className="mt-1.5 text-[12px] font-medium text-info hover:underline dark:text-info-dark">
              Criar a primeira
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] text-zinc-500">Nada com esse filtro.</p>
        ) : (
          <DataGrid fixed>
            <thead>
              <tr>
                <Th>API</Th>
                <Th className="w-[128px]">Tipo</Th>
                <Th className="w-[150px]">Métodos</Th>
                <Th className="w-[26%]">Origem / destino</Th>
                <Th className="w-[96px]">Estado</Th>
                <Th className="w-[92px]"><span className="sr-only">Ações</span></Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((it) => {
                // Produto: dono ou admin. Serviço interno: qualquer editor
                // edita e pausa (o backend reaprova); excluir é só de admin.
                const canManage = it.kind === 'service' || isAdmin || it.owner === me
                const canDelete = it.kind === 'service' ? isAdmin : canManage
                const Icon = KIND[it.kind].icon
                const isOpen = open === it.key
                return (
                  <Fragment key={it.key}>
                    <Tr onClick={() => setOpen(isOpen ? null : it.key)} className={isOpen ? 'bg-zinc-50 dark:bg-zinc-800/40' : undefined}>
                      <Td>
                        <span className="flex min-w-0 items-center gap-1.5">
                          <ChevronRight size={12} className={`shrink-0 text-zinc-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                          <span className="min-w-0">
                            <span className="block truncate text-[12px] font-medium">{it.name}</span>
                            <span className="block truncate font-mono text-[10px] text-zinc-400">{it.path}</span>
                          </span>
                        </span>
                      </Td>
                      <Td muted>
                        <span className="flex items-center gap-1.5"><Icon size={12} strokeWidth={1.6} className="shrink-0" />{KIND[it.kind].label}</span>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">{it.methods.map((m) => <MethodChip key={m} m={m} />)}</span>
                      </Td>
                      <Td>
                        <span className="block truncate font-mono text-[10.5px] text-zinc-500" title={it.target}>{it.target}</span>
                      </Td>
                      <Td><StatePill it={it} /></Td>
                      <Td onClick={(e) => e.stopPropagation()}>
                        <span className="flex items-center justify-end gap-0.5">
                          {canManage && it.status === 'active' && (
                            <button title={it.enabled ? 'Pausar' : 'Pôr no ar'} onClick={() => onToggle(it)} className={ICON_BTN}>
                              <Power size={13} />
                            </button>
                          )}
                          {canManage && (
                            <button title="Editar" onClick={() => onEdit(it)} className={ICON_BTN}><Pencil size={13} /></button>
                          )}
                          {canDelete && (
                            <button title="Excluir" onClick={() => onDelete(it)} className={ICON_BTN_DANGER}><Trash2 size={13} /></button>
                          )}
                        </span>
                      </Td>
                    </Tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} className="border-b border-zinc-200 bg-zinc-50/60 px-3 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                          <Detail it={it} canTest={canManage} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </DataGrid>
        )}
      </Card>
    </>
  )
}

// Exemplo de valor por tipo, para o exemplo de chamada e para o teste.
const sample = (c: ApiProductColumn) => (c.type === 'number' ? 0 : c.type === 'bool' ? true : c.type === 'date' ? '2026-01-31' : 'exemplo')
const objOf = (cols: ApiProductColumn[]) => Object.fromEntries(cols.map((c) => [c.col, sample(c)]))

function Detail({ it, canTest }: { it: CatalogItem; canTest: boolean }) {
  const [copied, setCopied] = useState(false)
  const [testOut, setTestOut] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const base = `${window.location.origin}/api/public/v1`
  const p = it.product
  const u = it.upstream

  // O token vai no cabeçalho X-Api-Token: na URL ele é recusado (SEG-06).
  let snippet: string
  let facts: string[]
  if (p && p.kind !== 'write') {
    snippet = `curl -H "X-Api-Token: SEU_TOKEN" "${base}${it.path}${p.pagination === 'page' ? '?page=1' : '?offset=0'}"`
    facts = [
      `conjunto ${p.datasetSlug}`,
      p.pagination === 'page' ? 'paginação page/size' : 'paginação offset/limit',
      `limite ${p.defaultLimit} por página (máx. ${p.maxLimit})`,
      p.readFilters?.length ? `filtros fixos: ${p.readFilters.map((f) => `${f.field} ${f.op} ${String(f.value)}`).join(' · ')}` : 'sem filtro fixo',
      'responde só a token cujo escopo de leitura inclua o conjunto',
    ]
  } else if (p) {
    const setCols = p.columns ?? []
    const keyCols = p.keyColumns ?? []
    const body = p.writeOp === 'update' ? { set: objOf(setCols), where: objOf(keyCols) }
      : p.writeOp === 'delete' ? { where: objOf(keyCols) } : objOf(setCols)
    snippet = `curl -X ${p.method} "${base}${it.path}" \\\n  -H "X-Api-Token: SEU_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`
    facts = [
      `${p.connectionId}: ${p.schemaName}.${p.tableName}`,
      ...(p.writeOp !== 'delete' ? [`campos: ${setCols.map((c) => c.col + (c.required ? '*' : '')).join(', ') || '—'}`] : []),
      ...(p.writeOp !== 'insert' ? [`filtro por ${keyCols.map((k) => k.col).join('/') || '—'}`] : []),
      p.maxAffected != null ? `teto de ${p.maxAffected} linha(s) por chamada` : 'sem teto de linhas',
      'responde só a token com esta API marcada em Escrita',
    ]
  } else {
    snippet = `curl -H "X-Api-Token: SEU_TOKEN" "${base}${it.path}/{caminho}"`
    facts = [
      u!.description || 'sem descrição',
      `destino ${u!.baseUrl}${u!.stripPrefix ? ` (sem o prefixo ${it.path})` : ''}`,
      `autenticação: ${AUTH_LABEL[u!.authMode]}${u!.hasSecret ? ' · segredo guardado' : ''}`,
      `tempo limite ${(u!.timeoutMs / 1000).toLocaleString('pt-BR')}s`,
      'responde só a token com este serviço marcado em Serviços internos',
    ]
  }

  async function runTest() {
    if (!p) return
    setTesting(true); setTestOut(null)
    try {
      const setCols = p.columns ?? []
      const keyCols = p.keyColumns ?? []
      const body = p.kind !== 'write' ? {}
        : p.writeOp === 'update' ? { set: objOf(setCols), where: objOf(keyCols) }
        : p.writeOp === 'delete' ? { where: objOf(keyCols) }
        : { body: objOf(setCols) }
      const r = await api<Record<string, unknown>>(`/api/v1/products/${p.id}/test`, { method: 'POST', body: JSON.stringify(body) })
      setTestOut(JSON.stringify(r, null, 2))
    } catch (e) { setTestOut(errMsg(e, 'Falha no teste.')) }
    finally { setTesting(false) }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="min-w-0">
        <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">Como funciona</p>
        <ul className="space-y-0.5 text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-300">
          {facts.map((f) => <li key={f} className="break-words">· {f}</li>)}
        </ul>
        <p className="mt-2 text-[10.5px] text-zinc-400">dono: {it.owner}</p>
      </div>
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-2">
          <p className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">Exemplo de chamada</p>
          <button onClick={() => { void navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
            className="ml-auto flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            {copied ? <Check size={12} /> : <Copy size={12} />} copiar
          </button>
          {p && canTest && (
            <button onClick={() => void runTest()} disabled={testing || p.status !== 'active'}
              title={p.status !== 'active' ? 'Disponível depois de aprovada' : 'Chama a API agora, pela sua sessão'}
              className="flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 hover:border-zinc-300 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300">
              {testing ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Testar
            </button>
          )}
        </div>
        <pre className="overflow-x-auto rounded-lg bg-white p-2.5 font-mono text-[10.5px] leading-relaxed dark:bg-zinc-900"><code>{snippet}</code></pre>
        {testOut && <pre className="mt-2 max-h-52 overflow-auto rounded-lg bg-white p-2.5 font-mono text-[10.5px] dark:bg-zinc-900"><code>{testOut}</code></pre>}
      </div>
    </div>
  )
}
