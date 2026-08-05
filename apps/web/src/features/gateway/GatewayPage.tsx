// Gateway de APIs — plano de CONTROLE.
//
// Duas coisas convivem aqui, e a tela separa isso na cara: os UPSTREAMS (APIs
// internas que passam a ser servidas atrás do gateway) e os CONSUMIDORES (quem
// chama, com quota e limite). O contrato é do consumidor, não do serviço de
// trás — por isso a política mora no token.
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Webhook, Plus, Pencil, Trash2, Power, Check, X, ShieldCheck, Gauge,
  Users, Activity, Clock, Loader2, AlertTriangle, Copy,
} from 'lucide-react'
import type { GatewayUpstream, GatewayUsage, GatewayAuthMode } from '@datahub/shared'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import KpiBar, { type Kpi } from '@/components/ui/KpiBar'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { DataGrid, Th, Tr, Td, EntityCell, MiniBar } from '@/components/ui/DataGrid'

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

const METHOD_CLS: Record<string, string> = {
  GET: 'bg-info-soft text-info dark:bg-info/15 dark:text-info-dark',
  POST: 'bg-ok-soft text-ok dark:bg-ok/15 dark:text-ok-dark',
  PUT: 'bg-warn-soft text-warn dark:bg-warn/15 dark:text-warn-dark',
  PATCH: 'bg-warn-soft text-warn dark:bg-warn/15 dark:text-warn-dark',
  DELETE: 'bg-crit-soft text-crit dark:bg-crit/15 dark:text-crit-dark',
  HEAD: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
}

const AUTH_LABEL: Record<GatewayAuthMode, string> = {
  none: 'Sem autenticação',
  bearer: 'Bearer token',
  header: 'Header customizado',
  basic: 'Basic (usuário:senha)',
}

function MethodChip({ m }: { m: string }) {
  return (
    <span className={`rounded px-1.5 py-px font-mono text-[9.5px] font-semibold ${METHOD_CLS[m] ?? METHOD_CLS.HEAD}`}>
      {m}
    </span>
  )
}

// ── Página ─────────────────────────────────────────────────────────────────
export default function GatewayPage() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = !!user?.roles.includes('admin')
  const confirm = useConfirm()

  const [upstreams, setUpstreams] = useState<GatewayUpstream[]>([])
  const [usage, setUsage] = useState<GatewayUsage[]>([])
  const [secretConfigured, setSecretConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<GatewayUpstream | null | 'new'>(null)
  const [policyFor, setPolicyFor] = useState<GatewayUsage | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [u, g] = await Promise.all([
        api<{ upstreams: GatewayUpstream[]; secretConfigured: boolean }>('/api/v1/gateway/upstreams'),
        api<{ usage: GatewayUsage[] }>('/api/v1/gateway/usage'),
      ])
      setUpstreams(u.upstreams)
      setSecretConfigured(u.secretConfigured)
      setUsage(g.usage)
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const pending = useMemo(() => upstreams.filter((u) => u.status === 'pending'), [upstreams])
  const active = useMemo(() => upstreams.filter((u) => u.status === 'active'), [upstreams])
  const callsToday = useMemo(() => usage.reduce((s, u) => s + Number(u.calls_today), 0), [usage])
  const consumersToday = useMemo(() => usage.filter((u) => Number(u.calls_today) > 0).length, [usage])
  const unlimited = useMemo(() => usage.filter((u) => !u.rate_limit_per_min && !u.quota_per_day).length, [usage])

  async function review(u: GatewayUpstream, status: 'active' | 'rejected') {
    if (status === 'rejected' && !(await confirm({
      title: `Rejeitar "${u.name}"?`,
      message: 'O upstream deixa de responder no gateway até ser aprovado.',
      confirmLabel: 'Rejeitar', danger: true,
    }))) return
    await api(`/api/v1/gateway/upstreams/${u.id}/review`, { method: 'POST', body: JSON.stringify({ status }) })
    void load()
  }

  async function toggle(u: GatewayUpstream) {
    await api(`/api/v1/gateway/upstreams/${u.id}/enabled`, {
      method: 'POST', body: JSON.stringify({ enabled: !u.enabled }),
    })
    void load()
  }

  async function remove(u: GatewayUpstream) {
    if (!(await confirm({
      title: `Excluir "${u.name}"?`,
      message: `O endereço /gw/${u.slug} deixa de existir imediatamente. Consumidores que o chamam passam a receber 404.`,
      confirmLabel: 'Excluir', danger: true,
    }))) return
    await api(`/api/v1/gateway/upstreams/${u.id}`, { method: 'DELETE' })
    void load()
  }

  const kpis: Kpi[] = [
    { label: 'Upstreams ativos', icon: Webhook, value: String(active.length), foot: `${upstreams.length} cadastrado(s)` },
    { label: 'Aguardando aprovação', icon: ShieldCheck, value: String(pending.length), foot: pending.length ? 'não respondem ainda' : 'nada na fila' },
    { label: 'Chamadas hoje', icon: Activity, value: callsToday.toLocaleString('pt-BR'), foot: `${consumersToday} consumidor(es) ativo(s)` },
    { label: 'Tokens sem limite', icon: Gauge, value: String(unlimited), foot: unlimited ? 'sem quota nem rate limit' : 'todos com política' },
  ]

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Gateway de APIs</h1>
          <p className="mt-0.5 text-[12px] text-zinc-500">
            APIs internas servidas com token, quota e telemetria — sem o serviço de trás mudar nada.
          </p>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover active:scale-95"
        >
          <Plus size={14} strokeWidth={2} /> Novo upstream
        </button>
      </div>

      {!secretConfigured && (
        <div className="mt-3 flex items-start gap-2.5 rounded-2xl border border-warn/40 bg-warn-soft p-3 dark:bg-warn/10">
          <AlertTriangle size={15} className="mt-px shrink-0 text-warn dark:text-warn-dark" />
          <p className="text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            <b>CONNECTIONS_SECRET não está definida.</b> Sem ela o gateway não consegue guardar a credencial
            do upstream com segurança — só upstreams sem autenticação vão funcionar. Defina a variável na stack.
          </p>
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-center gap-2.5 rounded-2xl border border-crit/40 bg-crit-soft p-3 dark:bg-crit/10">
          <AlertTriangle size={15} className="shrink-0 text-crit dark:text-crit-dark" />
          <p className="text-[12px] text-crit dark:text-crit-dark">{error}</p>
          <button onClick={() => void load()} className="ml-auto text-[11.5px] font-medium text-info hover:underline dark:text-info-dark">
            Tentar de novo
          </button>
        </div>
      )}

      {loading ? (
        <div className="mt-3.5 grid gap-2.5">
          <div className="h-[76px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
          <div className="h-[220px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
        </div>
      ) : (
        <div className="mt-3.5 flex flex-col gap-2.5">
          <KpiBar items={kpis} />

          {/* Fila de aprovação — só aparece quando há o que decidir. */}
          {isAdmin && pending.length > 0 && (
            <Card className="border-warn/40">
              <CardHead icon={ShieldCheck} title="Aguardando sua aprovação" sub={`${pending.length} upstream(s)`} />
              <div className="flex flex-col">
                {pending.map((u) => (
                  <div key={u.id} className="flex items-center gap-3 border-b border-zinc-200 px-3 py-2 last:border-b-0 dark:border-zinc-800">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium">{u.name}</p>
                      <p className="truncate font-mono text-[10.5px] text-zinc-500">
                        /gw/{u.slug} → {u.baseUrl}
                      </p>
                    </div>
                    <div className="hidden shrink-0 items-center gap-1 sm:flex">
                      {u.methods.map((m) => <MethodChip key={m} m={m} />)}
                    </div>
                    <span className="shrink-0 text-[10.5px] text-zinc-400">{u.ownerEmail}</span>
                    <button
                      onClick={() => void review(u, 'active')}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-ok px-2.5 py-1 text-[11px] font-semibold text-white transition-opacity hover:opacity-90"
                    >
                      <Check size={12} strokeWidth={2.4} /> Aprovar
                    </button>
                    <button
                      onClick={() => void review(u, 'rejected')}
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:border-crit hover:text-crit dark:border-zinc-700 dark:text-zinc-300"
                    >
                      <X size={12} strokeWidth={2.4} /> Rejeitar
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Upstreams */}
          <Card>
            <CardHead icon={Webhook} title="Upstreams" sub={`${upstreams.length} cadastrado(s)`} />
            {upstreams.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <Webhook size={26} strokeWidth={1.2} className="mx-auto mb-2 text-zinc-300 dark:text-zinc-700" />
                <p className="text-[12px] text-zinc-500">Nenhuma API interna registrada ainda.</p>
                <button onClick={() => setEditing('new')} className="mt-1.5 text-[12px] font-medium text-info hover:underline dark:text-info-dark">
                  Registrar a primeira
                </button>
              </div>
            ) : (
              <DataGrid>
                <thead>
                  <tr>
                    <Th>Upstream</Th>
                    <Th>Destino</Th>
                    <Th className="w-[150px]">Métodos</Th>
                    <Th className="w-[104px]">Autenticação</Th>
                    <Th right className="w-[76px]">Timeout</Th>
                    <Th className="w-[96px]">Estado</Th>
                    <Th className="w-[104px]" />
                  </tr>
                </thead>
                <tbody>
                  {upstreams.map((u) => (
                    <Tr key={u.id}>
                      <Td><EntityCell name={u.name} slug={`/gw/${u.slug}`} /></Td>
                      <Td>
                        <span className="flex items-center gap-1.5">
                          <span className="max-w-[260px] truncate font-mono text-[10.5px] text-zinc-500">{u.baseUrl}</span>
                          <button
                            title="Copiar destino"
                            onClick={() => void navigator.clipboard.writeText(u.baseUrl)}
                            className="shrink-0 text-zinc-400 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
                          >
                            <Copy size={11} />
                          </button>
                        </span>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">
                          {u.methods.map((m) => <MethodChip key={m} m={m} />)}
                        </span>
                      </Td>
                      <Td muted>
                        {u.authMode === 'none'
                          ? <span className="text-zinc-400">nenhuma</span>
                          : <span title={AUTH_LABEL[u.authMode]}>{u.authMode}{u.hasSecret ? ' ••••' : ''}</span>}
                      </Td>
                      <Td right muted>{(u.timeoutMs / 1000).toLocaleString('pt-BR')}s</Td>
                      <Td>
                        {u.status === 'pending' && <Pill tone="warn">pendente</Pill>}
                        {u.status === 'rejected' && <Pill tone="crit">rejeitado</Pill>}
                        {u.status === 'active' && (u.enabled ? <Pill tone="ok" dot>no ar</Pill> : <Pill>pausado</Pill>)}
                      </Td>
                      <Td>
                        <span className="flex items-center justify-end gap-0.5">
                          <button title={u.enabled ? 'Pausar' : 'Reativar'} onClick={() => void toggle(u)}
                            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                            <Power size={13} />
                          </button>
                          <button title="Editar" onClick={() => setEditing(u)}
                            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                            <Pencil size={13} />
                          </button>
                          {isAdmin && (
                            <button title="Excluir" onClick={() => void remove(u)}
                              className="rounded p-1 text-zinc-400 transition-colors hover:bg-crit-soft hover:text-crit dark:hover:bg-crit/15">
                              <Trash2 size={13} />
                            </button>
                          )}
                        </span>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </DataGrid>
            )}
          </Card>

          {/* Consumidores: quem chama, quanto já gastou e qual o teto */}
          <Card>
            <CardHead icon={Users} title="Consumidores" sub="consumo de hoje">
              {isAdmin && <span className="text-[10.5px] text-zinc-400">clique para definir limites</span>}
            </CardHead>
            {usage.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-zinc-500">
                Nenhum token ativo. Crie um em Integrações.
              </p>
            ) : (
              <DataGrid>
                <thead>
                  <tr>
                    <Th>Token</Th>
                    <Th right className="w-[108px]">Chamadas hoje</Th>
                    <Th className="w-[170px]">Cota diária</Th>
                    <Th right className="w-[112px]">Limite / min</Th>
                    <Th className="w-[96px]">Estado</Th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((c) => {
                    const calls = Number(c.calls_today)
                    const quota = c.quota_per_day
                    const pct = quota ? (calls / quota) * 100 : 0
                    const noPolicy = !quota && !c.rate_limit_per_min
                    return (
                      <Tr key={c.id} onClick={isAdmin ? () => setPolicyFor(c) : undefined}>
                        <Td><span className="text-[12px] font-medium">{c.name}</span></Td>
                        <Td right muted>{calls.toLocaleString('pt-BR')}</Td>
                        <Td>
                          {quota ? (
                            <span className="flex items-center gap-2">
                              <MiniBar pct={pct} />
                              <span className="text-[11px] tabular-nums text-zinc-500">
                                {calls.toLocaleString('pt-BR')} / {quota.toLocaleString('pt-BR')}
                              </span>
                            </span>
                          ) : <span className="text-[11px] text-zinc-400">sem cota</span>}
                        </Td>
                        <Td right muted>{c.rate_limit_per_min ? `${c.rate_limit_per_min}/min` : '—'}</Td>
                        <Td>
                          {noPolicy
                            ? <Pill tone="warn">sem limite</Pill>
                            : quota && pct >= 100
                              ? <Pill tone="crit">cota esgotada</Pill>
                              : quota && pct >= 80
                                ? <Pill tone="warn">{Math.round(pct)}% da cota</Pill>
                                : <Pill tone="ok">saudável</Pill>}
                        </Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </DataGrid>
            )}
          </Card>
        </div>
      )}

      {editing && (
        <UpstreamDialog
          initial={editing === 'new' ? null : editing}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load() }}
        />
      )}
      {policyFor && (
        <PolicyDialog
          consumer={policyFor}
          upstreams={active}
          onClose={() => setPolicyFor(null)}
          onSaved={() => { setPolicyFor(null); void load() }}
        />
      )}
    </div>
  )
}

// ── Editor de upstream ─────────────────────────────────────────────────────
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">{label}</span>
      {children}
      {hint && <span className="text-[10.5px] leading-snug text-zinc-400">{hint}</span>}
    </label>
  )
}

const INPUT = 'w-full rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[12px] transition-colors '
  + 'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 '
  + 'dark:border-zinc-800 dark:bg-zinc-950'

function UpstreamDialog({ initial, isAdmin, onClose, onSaved }: {
  initial: GatewayUpstream | null
  isAdmin: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial
  const [slug, setSlug] = useState(initial?.slug ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [methods, setMethods] = useState<string[]>(initial?.methods ?? ['GET'])
  const [timeoutSec, setTimeoutSec] = useState(String((initial?.timeoutMs ?? 15_000) / 1000))
  const [stripPrefix, setStripPrefix] = useState(initial?.stripPrefix ?? true)
  const [authMode, setAuthMode] = useState<GatewayAuthMode>(initial?.authMode ?? 'none')
  const [authHeader, setAuthHeader] = useState(initial?.authHeader ?? '')
  const [secret, setSecret] = useState('')
  const [forwardHeaders, setForwardHeaders] = useState((initial?.forwardHeaders ?? []).join(', '))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  async function save() {
    setSaving(true)
    setErr(null)
    const payload = {
      slug: slug.trim(), name, description, baseUrl: baseUrl.trim(),
      methods, timeoutMs: Math.round(Number(timeoutSec) * 1000), stripPrefix,
      authMode, authHeader: authHeader.trim() || null,
      // Ausente = mantém o segredo atual; o backend só troca quando vem valor.
      ...(secret ? { secret } : {}),
      forwardHeaders: forwardHeaders.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    }
    try {
      await api(isEdit ? `/api/v1/gateway/upstreams/${initial!.id}` : '/api/v1/gateway/upstreams', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      onSaved()
    } catch (e) {
      setErr((e as ApiError).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card-lg dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2.5 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <Webhook size={15} className="text-accent" />
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold">{isEdit ? 'Editar upstream' : 'Novo upstream'}</h2>
            <p className="text-[10.5px] text-zinc-500">
              {isAdmin ? 'Entra já aprovado.' : 'Entra como pendente até um administrador aprovar.'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Fechar" className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome">
              <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Estoque de equipamentos" />
            </Field>
            <Field label="Identificador" hint={`Endereço público: /api/public/v1/gw/${slug || '…'}`}>
              <input className={INPUT} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="estoque" />
            </Field>
          </div>

          <div className="mt-3">
            <Field label="Descrição">
              <input className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para que serve e quem é o dono do serviço" />
            </Field>
          </div>

          <div className="mt-3">
            <Field label="URL de destino" hint="Endereço interno do serviço. O consumidor nunca o vê.">
              <input className={INPUT} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://estoque.interno:8080/api" />
            </Field>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Métodos permitidos">
              <div className="flex flex-wrap gap-1">
                {ALL_METHODS.map((m) => {
                  const on = methods.includes(m)
                  return (
                    <button key={m} type="button"
                      onClick={() => setMethods(on ? methods.filter((x) => x !== m) : [...methods, m])}
                      className={`rounded px-2 py-1 font-mono text-[10px] font-semibold transition-colors ${
                        on ? METHOD_CLS[m] : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800'}`}>
                      {m}
                    </button>
                  )
                })}
              </div>
            </Field>
            <Field label="Tempo limite (s)" hint="Estourou, o consumidor recebe 504 — a conexão não fica pendurada.">
              <input className={INPUT} type="number" min="0.5" max="120" step="0.5"
                value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
            </Field>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Autenticação no destino">
              <select className={INPUT} value={authMode} onChange={(e) => setAuthMode(e.target.value as GatewayAuthMode)}>
                {(Object.keys(AUTH_LABEL) as GatewayAuthMode[]).map((m) => (
                  <option key={m} value={m}>{AUTH_LABEL[m]}</option>
                ))}
              </select>
            </Field>
            {authMode === 'header' && (
              <Field label="Nome do header">
                <input className={INPUT} value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} placeholder="x-api-key" />
              </Field>
            )}
            {authMode !== 'none' && (
              <Field
                label="Segredo"
                hint={initial?.hasSecret ? 'Já existe um segredo guardado. Deixe vazio para mantê-lo.' : 'Cifrado em repouso; nunca volta numa resposta.'}
              >
                <input className={INPUT} type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
                  placeholder={initial?.hasSecret ? '••••••••' : 'valor da credencial'} autoComplete="new-password" />
              </Field>
            )}
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Headers repassados" hint="Além de content-type, accept, accept-language e user-agent. Separe por vírgula.">
              <input className={INPUT} value={forwardHeaders} onChange={(e) => setForwardHeaders(e.target.value)} placeholder="x-tenant, x-locale" />
            </Field>
            <Field label="Prefixo">
              <label className="flex items-center gap-2 pt-1.5 text-[12px]">
                <input type="checkbox" checked={stripPrefix} onChange={(e) => setStripPrefix(e.target.checked)}
                  className="h-3.5 w-3.5 accent-accent" />
                Remover <code className="font-mono text-[11px]">/gw/{slug || 'slug'}</code> antes de repassar
              </label>
            </Field>
          </div>

          {err && (
            <p className="mt-3 rounded-lg bg-crit-soft px-2.5 py-2 text-[11.5px] text-crit dark:bg-crit/15 dark:text-crit-dark">{err}</p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            Cancelar
          </button>
          <button onClick={() => void save()} disabled={saving || !name || !slug || !baseUrl || !methods.length}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.4} />}
            {isEdit ? 'Salvar' : 'Registrar'}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ── Política do consumidor ─────────────────────────────────────────────────
function PolicyDialog({ consumer, upstreams, onClose, onSaved }: {
  consumer: GatewayUsage
  upstreams: GatewayUpstream[]
  onClose: () => void
  onSaved: () => void
}) {
  const [rate, setRate] = useState(consumer.rate_limit_per_min?.toString() ?? '')
  const [quota, setQuota] = useState(consumer.quota_per_day?.toString() ?? '')
  const [slugs, setSlugs] = useState<string[]>(consumer.upstream_slugs ?? [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await api(`/api/v1/gateway/credentials/${consumer.id}/policy`, {
        method: 'PUT',
        body: JSON.stringify({
          rateLimitPerMin: rate === '' ? null : Number(rate),
          quotaPerDay: quota === '' ? null : Number(quota),
          upstreamSlugs: slugs,
        }),
      })
      onSaved()
    } catch (e) {
      setErr((e as ApiError).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-[460px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card-lg dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2.5 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <Gauge size={15} className="text-accent" />
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold">Limites de "{consumer.name}"</h2>
            <p className="text-[10.5px] text-zinc-500">Vazio = sem limite.</p>
          </div>
          <button onClick={onClose} aria-label="Fechar" className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </header>

        <div className="p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Requisições por minuto" hint="Protege o motor de um pico.">
              <input className={INPUT} type="number" min="1" value={rate}
                onChange={(e) => setRate(e.target.value)} placeholder="sem limite" />
            </Field>
            <Field label="Cota diária" hint="Zera à meia-noite. Sobrevive a redeploy.">
              <input className={INPUT} type="number" min="1" value={quota}
                onChange={(e) => setQuota(e.target.value)} placeholder="sem limite" />
            </Field>
          </div>

          <div className="mt-3">
            <Field label="Upstreams que este token alcança" hint="Acesso a upstream é opt-in: nada marcado = nenhum.">
              {upstreams.length === 0 ? (
                <p className="text-[11.5px] text-zinc-400">Nenhum upstream aprovado ainda.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {upstreams.map((u) => {
                    const on = slugs.includes(u.slug)
                    return (
                      <button key={u.id} type="button"
                        onClick={() => setSlugs(on ? slugs.filter((s) => s !== u.slug) : [...slugs, u.slug])}
                        className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                          on
                            ? 'border-transparent bg-accent text-zinc-950'
                            : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-700'}`}>
                        {u.slug}
                      </button>
                    )
                  })}
                </div>
              )}
            </Field>
          </div>

          <p className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-snug text-zinc-400">
            <Clock size={12} className="mt-px shrink-0" />
            O limite por minuto é contado em memória e reinicia junto com o serviço; a cota diária fica no banco.
          </p>

          {err && (
            <p className="mt-3 rounded-lg bg-crit-soft px-2.5 py-2 text-[11.5px] text-crit dark:bg-crit/15 dark:text-crit-dark">{err}</p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            Cancelar
          </button>
          <button onClick={() => void save()} disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.4} />}
            Salvar
          </button>
        </footer>
      </div>
    </div>
  )
}
