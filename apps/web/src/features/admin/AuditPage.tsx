// Admin › Auditoria — histórico de ações do hub (audit_logs). Quem fez o quê,
// quando e sobre qual recurso. Filtros por ação (prefixo) e por usuário.
import { useEffect, useState } from 'react'
import { RefreshCw, Search, ScrollText } from 'lucide-react'
import { api } from '@/lib/api'

interface AuditLog {
  id: string
  userEmail: string | null
  action: string
  resourceType: string | null
  resourceId: string | null
  detail: unknown
  ip: string | null
  createdAt: string
}

// Rótulos amigáveis para os prefixos de ação mais comuns.
const ACTION_LABEL: Record<string, string> = {
  'datasets.publish': 'Publicou conjunto',
  'datasets.unpublish': 'Removeu conjunto',
  'datasets.update': 'Editou conjunto',
  'datasets.sync': 'Sincronizou',
  'datasets.sync-config': 'Config. de sync',
  'datasets.export': 'Exportou',
  'datasets.derived.create': 'Criou derivado',
  'datasets.derived.update': 'Editou derivado',
  'datasets.derived.materialize': 'Materializou derivado',
  'access.dataset.grant': 'Concedeu acesso',
  'access.dataset.grant.revoke': 'Revogou acesso',
  'access.dataset.visibility': 'Mudou visibilidade',
  'access.team.create': 'Criou time',
  'access.team.delete': 'Excluiu time',
  'access.team.member.add': 'Adicionou membro',
  'access.team.member.remove': 'Removeu membro',
  'access.user.role': 'Mudou papel',
  'dashboards.create': 'Criou dashboard',
  'dashboards.delete': 'Excluiu dashboard',
  'dashboards.share': 'Compartilhou dashboard',
  'metrics.create': 'Criou métrica',
  'metrics.delete': 'Excluiu métrica',
}

const QUICK_FILTERS = [
  { label: 'Tudo', prefix: '' },
  { label: 'Conjuntos', prefix: 'datasets.' },
  { label: 'Acessos', prefix: 'access.' },
  { label: 'Dashboards', prefix: 'dashboards.' },
  { label: 'Métricas', prefix: 'metrics.' },
]

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionPrefix, setActionPrefix] = useState('')
  const [user, setUser] = useState('')

  async function load() {
    setLogs(null)
    setError(null)
    try {
      const qs = new URLSearchParams()
      if (actionPrefix) qs.set('action', actionPrefix)
      if (user.trim()) qs.set('user', user.trim())
      const r = await api<{ logs: AuditLog[] }>(`/api/v1/admin/audit?${qs.toString()}`)
      setLogs(r.logs)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar a auditoria.')
    }
  }
  useEffect(() => { void load() }, [actionPrefix])

  function detailText(d: unknown): string {
    if (d === null || d === undefined) return ''
    if (typeof d === 'object') return Object.entries(d as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ')
    return String(d)
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ScrollText size={22} className="text-accent" /> Auditoria
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Quem fez o quê no hub — publicações, acessos, exportações e edições.</p>
        </div>
        <button onClick={() => void load()}
          className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          <RefreshCw size={14} /> Atualizar
        </button>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {QUICK_FILTERS.map((f) => (
          <button key={f.label} onClick={() => setActionPrefix(f.prefix)}
            className={`rounded-lg border px-3 py-1.5 text-xs ${actionPrefix === f.prefix
              ? 'border-accent bg-accent-soft dark:bg-zinc-800'
              : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700'}`}>
            {f.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input value={user} onChange={(e) => setUser(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
            placeholder="filtrar por e-mail…"
            className="w-52 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-3 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950" />
        </div>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      <div className="mt-5 overflow-hidden rounded-xl border border-zinc-200 shadow-card dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2.5 font-medium">Quando</th>
              <th className="px-4 py-2.5 font-medium">Usuário</th>
              <th className="px-4 py-2.5 font-medium">Ação</th>
              <th className="px-4 py-2.5 font-medium">Recurso</th>
              <th className="px-4 py-2.5 font-medium">Detalhe</th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-zinc-950">
            {logs?.map((l) => (
              <tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="whitespace-nowrap px-4 py-2 text-xs text-zinc-500">{new Date(l.createdAt).toLocaleString('pt-BR')}</td>
                <td className="px-4 py-2 text-xs">{l.userEmail ?? '—'}</td>
                <td className="px-4 py-2">
                  <span className="font-medium">{ACTION_LABEL[l.action] ?? l.action}</span>
                  <span className="ml-1 font-mono text-[10px] text-zinc-400">{l.action}</span>
                </td>
                <td className="px-4 py-2 text-xs text-zinc-500">{l.resourceId ?? '—'}</td>
                <td className="max-w-[260px] truncate px-4 py-2 text-xs text-zinc-500" title={detailText(l.detail)}>
                  {detailText(l.detail) || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs?.length === 0 && <p className="p-8 text-center text-sm text-zinc-500">Nenhum registro para este filtro.</p>}
        {logs === null && !error && <p className="p-8 text-center text-sm text-zinc-500">Carregando…</p>}
      </div>
    </div>
  )
}
