// Gateway de APIs — UMA tela para tudo o que o Data Hub serve por fora.
//
// Antes eram três (Integrações, APIs e Gateway) que falavam da mesma coisa por
// pedaços: o token nascia numa, ganhava limite em outra e a API que ele chama
// morava numa terceira; havia duas filas de aprovação. Para quem consome, é
// tudo "uma API, um endereço e um token" — e é assim que a tela se organiza:
//
//   Visão geral    o que está no ar, a fila única de aprovação, o consumo do dia
//   APIs           catálogo único: leitura (/p), escrita (/w), serviço interno (/gw)
//   Tokens         só admin (D-SEG-3): escopo, limites e uso num painel só
//   Como conectar  Power BI, Sheets, Excel, n8n, REST
//
// A aba vai no hash (#apis, #tokens, #conectar) para os endereços antigos
// redirecionarem para o lugar certo e o link poder ser compartilhado.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Webhook, Plus, KeyRound, LayoutGrid, Link2, Copy, Check, AlertTriangle, Database, PenLine, Radio, Lock,
} from 'lucide-react'
import type { ApiProduct, DatasetSummary, GatewayUpstream, GatewayUsage } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import { Page, PageHeader, PrimaryButton, ErrorBanner } from '@/components/ui/Page'
import { Card } from '@/components/ui/Card'
import { Dialog, BTN_SECONDARY, errMsg, type Credential } from './shared'
import ApisTab, { toItems, type CatalogItem, type ApiKind } from './ApisTab'
import OverviewTab from './OverviewTab'
import TokensTab from './TokensTab'
import ConnectTab from './ConnectTab'
import ApiBuilder from './ApiBuilder'
import UpstreamDialog from './UpstreamDialog'
import TokenDialog, { type TokenSaved } from './TokenDialog'

type TabKey = 'visao' | 'apis' | 'tokens' | 'conectar'
const HASH_TABS: TabKey[] = ['apis', 'tokens', 'conectar']

export default function GatewayApisPage() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = !!user?.roles.includes('admin')
  const isEditor = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const me = user?.email ?? ''
  const confirm = useConfirm()
  const { hash } = useLocation()
  const navigate = useNavigate()

  // Aba Tokens é só de admin; quem não é cai em Como conectar (era o que a
  // antiga /integrations mostrava para essa pessoa).
  const raw = hash.replace('#', '') as TabKey
  let tab: TabKey = HASH_TABS.includes(raw) ? raw : 'visao'
  if (tab === 'tokens' && !isAdmin) tab = 'conectar'
  const go = (t: TabKey) => navigate({ hash: t === 'visao' ? '' : t }, { replace: true })

  const [products, setProducts] = useState<ApiProduct[]>([])
  const [upstreams, setUpstreams] = useState<GatewayUpstream[]>([])
  const [secretConfigured, setSecretConfigured] = useState(true)
  const [credentials, setCredentials] = useState<Credential[] | null>(null)
  const [calls, setCalls] = useState<Map<string, number>>(new Map())
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [choosing, setChoosing] = useState(false)
  const [builder, setBuilder] = useState<{ kind: 'read' | 'write'; initial: ApiProduct | null } | null>(null)
  const [upstreamEdit, setUpstreamEdit] = useState<GatewayUpstream | 'new' | null>(null)
  const [tokenEdit, setTokenEdit] = useState<Credential | 'new' | null>(null)
  const [newToken, setNewToken] = useState<TokenSaved | null>(null)
  const [copied, setCopied] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!isEditor) return
    const errs: string[] = []
    const take = <T,>(p: Promise<T>) => p.catch((e) => { errs.push(errMsg(e, 'Falha ao carregar.')); return null })
    const [p, u, c, g] = await Promise.all([
      take(api<{ products: ApiProduct[] }>('/api/v1/products')),
      take(api<{ upstreams: GatewayUpstream[]; secretConfigured: boolean }>('/api/v1/gateway/upstreams')),
      // Token e consumo por token são só de admin (D-SEG-3): para os demais
      // as rotas respondem 403, então nem são pedidas.
      isAdmin ? take(api<{ credentials: Credential[] }>('/api/v1/credentials')) : Promise.resolve(null),
      isAdmin ? take(api<{ usage: GatewayUsage[] }>('/api/v1/gateway/usage')) : Promise.resolve(null),
    ])
    if (p) setProducts(p.products)
    if (u) { setUpstreams(u.upstreams); setSecretConfigured(u.secretConfigured) }
    if (c) setCredentials(c.credentials)
    if (g) setCalls(new Map(g.usage.map((x) => [x.id, Number(x.calls_today)])))
    setError(errs.length ? [...new Set(errs)].join(' · ') : null)
    setLoaded(true)
  }, [isAdmin, isEditor])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!isAdmin) return
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets.filter((d) => d.lastSyncAt))).catch(() => {})
  }, [isAdmin])

  const items = useMemo(() => toItems(products, upstreams), [products, upstreams])
  const writeProducts = useMemo(
    () => products.filter((p) => p.kind === 'write' && p.status === 'active').map((p) => ({ slug: p.slug, name: p.name })),
    [products],
  )
  const activeUpstreams = useMemo(() => upstreams.filter((u) => u.status === 'active'), [upstreams])

  // ── Ações nas APIs ────────────────────────────────────────────────────────
  async function run(fn: () => Promise<unknown>) {
    try { await fn(); await load() } catch (e) { setError(errMsg(e)) }
  }

  async function review(it: CatalogItem, approve: boolean) {
    if (!approve && !(await confirm({
      title: `Recusar "${it.name}"?`,
      message: 'Ela não vai ao ar. Quem criou pode editar e enviar de novo.',
      confirmLabel: 'Recusar', danger: true,
    }))) return
    await run(() => it.product
      ? api(`/api/v1/products/${it.product.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST' })
      : api(`/api/v1/gateway/upstreams/${it.upstream!.id}/review`, {
          method: 'POST', body: JSON.stringify({ status: approve ? 'active' : 'rejected' }),
        }))
  }

  async function toggle(it: CatalogItem) {
    await run(() => it.product
      ? api(`/api/v1/products/${it.product.id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled: !it.enabled }) })
      : api(`/api/v1/gateway/upstreams/${it.upstream!.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: !it.enabled }) }))
  }

  async function remove(it: CatalogItem) {
    if (!(await confirm({
      title: `Excluir "${it.name}"?`,
      message: `O endereço ${it.path} deixa de existir imediatamente. Quem o chama passa a receber 404. Não dá para desfazer.`,
      confirmLabel: 'Excluir', danger: true,
    }))) return
    await run(() => it.product
      ? api(`/api/v1/products/${it.product.id}`, { method: 'DELETE' })
      : api(`/api/v1/gateway/upstreams/${it.upstream!.id}`, { method: 'DELETE' }))
  }

  function edit(it: CatalogItem) {
    if (it.product) setBuilder({ kind: it.product.kind === 'write' ? 'write' : 'read', initial: it.product })
    else setUpstreamEdit(it.upstream!)
  }

  function startNew(kind: ApiKind) {
    setChoosing(false)
    if (kind === 'service') setUpstreamEdit('new')
    else setBuilder({ kind, initial: null })
  }

  // ── Ações nos tokens ──────────────────────────────────────────────────────
  async function setRevoked(c: Credential, revoked: boolean) {
    if (revoked && !(await confirm({
      title: 'Revogar token',
      message: `"${c.name}" deixa de funcionar imediatamente e as integrações que o usam vão parar. Ele continua na lista e pode ser reativado depois.`,
      danger: true, confirmLabel: 'Revogar',
    }))) return
    setBusyId(c.id)
    await run(() => api(`/api/v1/credentials/${c.id}`, { method: 'PATCH', body: JSON.stringify({ revoked }) }))
    setBusyId(null)
  }

  async function removeToken(c: Credential) {
    if (!(await confirm({
      title: 'Excluir token',
      message: `"${c.name}" será apagado definitivamente e some da lista. Quem ainda estiver usando esse token recebe erro de autenticação. O registro das chamadas já feitas é mantido. Não dá para desfazer.`,
      danger: true, confirmLabel: 'Excluir',
    }))) return
    setBusyId(c.id)
    await run(() => api(`/api/v1/credentials/${c.id}`, { method: 'DELETE' }))
    setBusyId(null)
  }

  if (!isEditor) {
    return (
      <Page>
        <PageHeader icon={Webhook} title="Gateway de APIs" />
        <Card className="p-4">
          <p className="flex items-center gap-2 text-[12.5px] font-semibold"><Lock size={14} className="text-zinc-400" /> Tela de editores e administradores</p>
          <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
            Para um Power BI, uma planilha ou um sistema ler os dados do Data Hub, peça um token a um administrador
            e diga quais conjuntos ele precisa ler.
          </p>
        </Card>
      </Page>
    )
  }

  const tabs: { key: TabKey; label: string; icon: typeof Webhook; count?: number }[] = [
    { key: 'visao', label: 'Visão geral', icon: LayoutGrid },
    { key: 'apis', label: 'APIs', icon: Webhook, count: items.length },
    ...(isAdmin ? [{ key: 'tokens' as const, label: 'Tokens', icon: KeyRound, count: credentials?.length }] : []),
    { key: 'conectar', label: 'Como conectar', icon: Link2 },
  ]

  return (
    <Page>
      <PageHeader icon={Webhook} title="Gateway de APIs"
        subtitle="Tudo o que o Data Hub serve por fora: APIs de dados, serviços internos e os tokens que os chamam.">
        {tab === 'tokens'
          ? <PrimaryButton icon={Plus} onClick={() => setTokenEdit('new')}>Novo token</PrimaryButton>
          : (
            <>
              {isAdmin && tab === 'visao' && (
                <button onClick={() => setTokenEdit('new')} className={`${BTN_SECONDARY} flex items-center gap-1.5`}>
                  <KeyRound size={13} /> Novo token
                </button>
              )}
              <PrimaryButton icon={Plus} onClick={() => setChoosing(true)}>Nova API</PrimaryButton>
            </>
          )}
      </PageHeader>

      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800" role="tablist">
        {tabs.map(({ key, label, icon: Icon, count }) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => go(key)}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] transition-colors ${tab === key
              ? 'border-accent font-semibold text-zinc-900 dark:text-zinc-100'
              : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'}`}>
            <Icon size={14} strokeWidth={1.6} /> {label}
            {count !== undefined && <span className="text-[10.5px] tabular-nums text-zinc-400">{count}</span>}
          </button>
        ))}
      </div>

      {!secretConfigured && (
        <div className="mb-2.5 flex items-start gap-2.5 rounded-2xl border border-warn/40 bg-warn-soft p-3 dark:bg-warn/10">
          <AlertTriangle size={15} className="mt-px shrink-0 text-warn dark:text-warn-dark" />
          <p className="text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            <b>CONNECTIONS_SECRET não está definida.</b> Sem ela o gateway não guarda a credencial de um serviço
            interno com segurança — só serviços sem autenticação vão funcionar. Defina a variável na stack.
          </p>
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={() => void load()} />}

      {/* Token recém-criado — única exibição */}
      {newToken?.token && (
        <div className="mb-2.5 rounded-2xl border border-warn/50 bg-warn-soft p-3 dark:bg-warn/10">
          <p className="text-[12px] font-semibold text-warn dark:text-warn-dark">
            Copie o token agora — ele não será mostrado novamente.
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Guardamos só o hash. Se perder, o caminho é excluir este e gerar outro.
          </p>
          {newToken.warning && <p className="mt-1 text-[11px] font-medium text-crit dark:text-crit-dark">{newToken.warning}</p>}
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-white px-3 py-2 font-mono text-[11px] dark:bg-zinc-900">{newToken.token}</code>
            <button onClick={() => { void navigator.clipboard.writeText(newToken.token!); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
              className="shrink-0 rounded-lg border border-warn/50 p-2 text-warn hover:bg-warn-soft dark:text-warn-dark">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <button onClick={() => setNewToken(null)} className="mt-2 text-[11px] text-zinc-500 underline">
            Já copiei, pode esconder
          </button>
        </div>
      )}

      {!loaded ? (
        <div className="grid gap-2.5">
          <div className="h-[76px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
          <div className="h-[220px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
        </div>
      ) : tab === 'visao' ? (
        <OverviewTab items={items} credentials={credentials ?? []} calls={calls} isAdmin={isAdmin} me={me}
          onReview={(it, ok) => void review(it, ok)} onEditToken={setTokenEdit}
          onGoTokens={() => go('tokens')} onGoApis={() => go('apis')} />
      ) : tab === 'apis' ? (
        <ApisTab items={items} isAdmin={isAdmin} me={me} onNew={() => setChoosing(true)}
          onEdit={edit} onToggle={(it) => void toggle(it)} onDelete={(it) => void remove(it)} />
      ) : tab === 'tokens' ? (
        <TokensTab credentials={credentials} calls={calls} me={me} busyId={busyId}
          onNew={() => setTokenEdit('new')} onEdit={setTokenEdit}
          onRevoke={(c, r) => void setRevoked(c, r)} onDelete={(c) => void removeToken(c)} />
      ) : (
        <ConnectTab isAdmin={isAdmin} onGoTokens={() => go('tokens')} onGoApis={() => go('apis')} />
      )}

      {choosing && <NewApiChooser onPick={startNew} onClose={() => setChoosing(false)} />}
      {builder && (
        <ApiBuilder kind={builder.kind} initial={builder.initial}
          onClose={() => setBuilder(null)} onSaved={() => void load()} />
      )}
      {upstreamEdit && (
        <UpstreamDialog initial={upstreamEdit === 'new' ? null : upstreamEdit} isAdmin={isAdmin}
          onClose={() => setUpstreamEdit(null)} onSaved={() => { setUpstreamEdit(null); void load() }} />
      )}
      {tokenEdit && (
        <TokenDialog initial={tokenEdit === 'new' ? null : tokenEdit}
          datasets={datasets} writeProducts={writeProducts} upstreams={activeUpstreams}
          onClose={() => setTokenEdit(null)}
          onSaved={(r) => {
            setTokenEdit(null)
            if (r.token) { setNewToken(r); go('tokens') }
            void load()
          }} />
      )}
    </Page>
  )
}

// "Nova API" pergunta o que a pessoa quer servir — os três tipos têm
// formulários diferentes, e o nome técnico (produto, upstream) não ajuda.
function NewApiChooser({ onPick, onClose }: { onPick: (k: ApiKind) => void; onClose: () => void }) {
  const opts: { k: ApiKind; icon: typeof Webhook; title: string; text: string; path: string }[] = [
    { k: 'read', icon: Database, title: 'Ler um conjunto', path: 'GET /p/{nome}', text: 'Expõe um conjunto do Data Hub com paginação e filtros fixos. Vai ao ar na hora.' },
    { k: 'write', icon: PenLine, title: 'Gravar num banco', path: 'POST · PUT · DELETE /w/{nome}', text: 'Insere, atualiza ou remove linhas num banco de origem. Passa por aprovação de um administrador.' },
    { k: 'service', icon: Radio, title: 'Publicar um serviço interno', path: '/gw/{nome}/…', text: 'Põe uma API que já existe na casa atrás do gateway, com token, cota e telemetria, sem mexer nela.' },
  ]
  return (
    <Dialog icon={Plus} title="Nova API" sub="O que você quer servir?" width={520} onClose={onClose}>
      <div className="grid gap-2">
        {opts.map(({ k, icon: Icon, title, text, path }) => (
          <button key={k} onClick={() => onPick(k)}
            className="flex items-start gap-3 rounded-xl border border-zinc-200 p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft/40 dark:border-zinc-800 dark:hover:bg-zinc-800/60">
            <Icon size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-zinc-400" />
            <span className="min-w-0">
              <span className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] font-semibold">
                {title} <span className="font-mono text-[10px] font-normal text-zinc-400">{path}</span>
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-zinc-500">{text}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  )
}
