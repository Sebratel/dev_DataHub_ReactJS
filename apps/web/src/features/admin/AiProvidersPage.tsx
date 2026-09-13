// Provedores de IA — cadastrados aqui, não no .env.
//
// Antes a chave vivia na stack: trocar de modelo ou rotacionar a chave exigia
// editar variáveis e redeployar, e só quem tinha acesso ao servidor conseguia.
// Agora a troca é imediata e auditada.
//
// Duas decisões que moldam a tela:
//  1. A chave NUNCA volta do servidor — nem mascarada de forma reversível.
//     Mostramos só os 4 últimos caracteres, o suficiente para reconhecer qual é.
//  2. O botão "Testar" é o centro da tela. Chave errada e modelo inexistente
//     dão erros muito diferentes, e descobrir isso no meio de uma conversa com
//     a IA é a pior hora possível.
import { useCallback, useEffect, useState } from 'react'
import {
  Sparkles, Plus, Check, X, Loader2, Trash2, Pencil, Star, Zap, AlertTriangle, KeyRound, ListFilter,
} from 'lucide-react'
import type { AiProvider, AiProviderKind, AiProviderTestResult, AiModelOption } from '@datahub/shared'
import { api, ApiError } from '@/lib/api'
import { useConfirm } from '@/components/Dialogs'
import { Page, PageHeader, EmptyState, ErrorBanner, TableSkeleton, PrimaryButton } from '@/components/ui/Page'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'

// Modelos sugeridos por provedor. É lista de atalho, não trava: o campo aceita
// qualquer texto, porque catálogo de modelo muda mais rápido que deploy.
// ATENÇÃO ao mexer aqui: `models` são EXEMPLOS de formato de id, não um
// catálogo. Catálogo de modelo muda mais rápido que deploy — o gemini-2.5-pro
// desta lista saiu de circulação para chaves novas pouco depois de escrita. A
// fonte da verdade é "Buscar modelos da minha chave", que pergunta ao provedor.
const KINDS: {
  key: AiProviderKind
  label: string
  hint: string
  models: string[]
  keyHint: string
  baseUrlHint?: string
}[] = [
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    hint: 'O provedor usado hoje pelo assistente e pela construção de widgets.',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
    keyHint: 'Começa com sk-ant-…',
  },
  {
    key: 'openai',
    label: 'OpenAI e compatíveis',
    hint: 'Fala o dialeto Chat Completions — serve também para Azure OpenAI, Groq, OpenRouter e servidores locais. Basta apontar a URL base.',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o4-mini'],
    keyHint: 'Começa com sk-…',
    baseUrlHint: 'Padrão: https://api.openai.com/v1',
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    hint: 'API do Google AI Studio.',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    keyHint: 'Chave do Google AI Studio',
    baseUrlHint: 'Padrão: https://generativelanguage.googleapis.com/v1beta',
  },
]

const kindOf = (k: AiProviderKind) => KINDS.find((x) => x.key === k) ?? KINDS[0]

function timeAgo(iso: string | null): string {
  if (!iso) return 'nunca'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}

export default function AiProvidersPage() {
  const confirm = useConfirm()
  const [items, setItems] = useState<AiProvider[]>([])
  const [secretConfigured, setSecretConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<AiProvider | 'new' | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, AiProviderTestResult>>({})
  // Último provedor testado — o detalhe do resultado aparece num painel de
  // largura inteira, não espremido numa célula.
  const [lastTested, setLastTested] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await api<{ providers: AiProvider[]; secretConfigured: boolean }>('/api/v1/ai/providers')
      setItems(r.providers)
      setSecretConfigured(r.secretConfigured)
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function test(p: AiProvider) {
    setTesting(p.id)
    setLastTested(p.id)
    try {
      const r = await api<AiProviderTestResult>(`/api/v1/ai/providers/${p.id}/test`, { method: 'POST' })
      setTestResult((s) => ({ ...s, [p.id]: r }))
      await load()
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setTesting(null)
    }
  }

  async function makeDefault(p: AiProvider) {
    try {
      await api(`/api/v1/ai/providers/${p.id}/default`, { method: 'POST' })
      await load()
    } catch (e) {
      setError((e as ApiError).message)
    }
  }

  async function remove(p: AiProvider) {
    if (!(await confirm({
      title: `Excluir "${p.name}"?`,
      message: p.isDefault
        ? 'Este é o provedor padrão. Sem outro no lugar, o assistente de IA para de responder.'
        : 'A chave cadastrada é apagada. Esta ação não pode ser desfeita.',
      confirmLabel: 'Excluir', danger: true,
    }))) return
    try {
      await api(`/api/v1/ai/providers/${p.id}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError((e as ApiError).message)
    }
  }

  const active = items.find((p) => p.isDefault && p.enabled)

  return (
    <Page>
      <PageHeader
        icon={Sparkles}
        title="Provedores de IA"
        subtitle="Cadastre o modelo e a chave aqui — sem editar o .env nem redeployar."
      >
        <PrimaryButton icon={Plus} onClick={() => setEditing('new')}>Novo provedor</PrimaryButton>
      </PageHeader>

      {!secretConfigured && (
        <div className="mb-2.5 flex items-start gap-2.5 rounded-2xl border border-warn/40 bg-warn-soft p-3 dark:bg-warn/10">
          <KeyRound size={15} className="mt-px shrink-0 text-warn dark:text-warn-dark" />
          <p className="text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            <b>CONNECTIONS_SECRET não está definida.</b> É a chave que cifra os segredos em repouso —
            sem ela não é possível guardar a chave do provedor. Defina a variável na stack antes de cadastrar.
          </p>
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={() => void load()} />}

      {loading ? <TableSkeleton /> : (
        <div className="flex flex-col gap-2.5">
          {/* Quem está respondendo agora — a pergunta nº 1 de quem abre esta tela */}
          <Card>
            <CardHead icon={Zap} title="Respondendo agora" />
            {active ? (
              <div className="px-3 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">{active.name}</p>
                    <p className="font-mono text-[11px] text-zinc-500">
                      {kindOf(active.kind).label} · {active.model}
                    </p>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    {active.lastTestOk === true && <Pill tone="ok" dot>testado há {timeAgo(active.lastTestAt)}</Pill>}
                    {active.lastTestOk === false && <Pill tone="crit">último teste falhou</Pill>}
                    {active.lastTestOk === null && <Pill tone="warn">nunca testado</Pill>}
                  </div>
                </div>
                {/* O motivo vem do banco, então sobrevive ao recarregar — antes
                    só existia no hover da pílula e sumia a cada F5. */}
                {active.lastTestOk === false && active.lastTestError && (
                  <p className="mt-1.5 whitespace-pre-wrap break-words rounded-lg bg-crit-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-crit dark:bg-crit/15 dark:text-crit-dark">
                    {active.lastTestError}
                  </p>
                )}
              </div>
            ) : (
              <p className="px-3 py-4 text-center text-[12px] text-zinc-500">
                Nenhum provedor ativo — o assistente de IA e a construção de widgets estão indisponíveis.
              </p>
            )}
          </Card>

          <Card>
            <CardHead icon={Sparkles} title="Provedores" sub={`${items.length}`} />
            {items.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                message="Nenhum provedor cadastrado. Adicione um da Anthropic, OpenAI ou Google para ligar o assistente."
                action={
                  <button onClick={() => setEditing('new')} className="text-[12px] font-medium text-info hover:underline dark:text-info-dark">
                    Cadastrar o primeiro
                  </button>
                }
              />
            ) : (
              <DataGrid fixed>
                <thead>
                  <tr>
                    <Th>Provedor</Th>
                    <Th className="w-[168px]">Tipo</Th>
                    <Th className="w-[110px]">Chave</Th>
                    <Th className="w-[132px]">Último teste</Th>
                    <Th className="w-[96px]">Estado</Th>
                    <Th className="w-[140px]" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                      <Tr key={p.id}>
                        <Td>
                          <EntityCell name={p.name} slug={p.model}>
                            {p.isDefault
                              ? <Star size={13} strokeWidth={1.8} className="shrink-0 text-accent" />
                              : <Sparkles size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />}
                          </EntityCell>
                        </Td>
                        <Td muted>{kindOf(p.kind).label}</Td>
                        <Td muted>
                          {p.hasKey
                            ? <span className="font-mono text-[11px]">••••{p.keyHint ?? ''}</span>
                            : <span className="text-crit dark:text-crit-dark">ausente</span>}
                        </Td>
                        <Td>
                          {p.lastTestAt ? (
                            <span className="flex items-center gap-1.5">
                              {p.lastTestOk
                                ? <Pill tone="ok">{p.lastTestMs} ms</Pill>
                                : <span title={p.lastTestError ?? ''}><Pill tone="crit">falhou</Pill></span>}
                              <span className="text-[10.5px] text-zinc-400">há {timeAgo(p.lastTestAt)}</span>
                            </span>
                          ) : <span className="text-[11px] text-zinc-400">nunca</span>}
                        </Td>
                        <Td>
                          {p.isDefault
                            ? <Pill tone="ok" dot>padrão</Pill>
                            : p.enabled ? <Pill>disponível</Pill> : <Pill tone="warn">desativado</Pill>}
                        </Td>
                        <Td>
                          <span className="flex items-center justify-end gap-0.5">
                            <button onClick={() => void test(p)} disabled={testing === p.id || !p.hasKey}
                              title="Testar conexão"
                              className="flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-[10.5px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
                              {testing === p.id ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
                              Testar
                            </button>
                            {!p.isDefault && (
                              <button onClick={() => void makeDefault(p)} title="Tornar padrão"
                                className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-accent dark:hover:bg-zinc-800">
                                <Star size={13} />
                              </button>
                            )}
                            <button onClick={() => setEditing(p)} title="Editar"
                              className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                              <Pencil size={13} />
                            </button>
                            <button onClick={() => void remove(p)} title="Excluir"
                              className="rounded p-1 text-zinc-400 transition-colors hover:bg-crit-soft hover:text-crit dark:hover:bg-crit/15">
                              <Trash2 size={13} />
                            </button>
                          </span>

                        </Td>
                      </Tr>
                  ))}
                </tbody>
              </DataGrid>
            )}
          </Card>

          {(() => {
            const p = items.find((x) => x.id === lastTested)
            const r = lastTested ? testResult[lastTested] : null
            if (!p || !r) return null
            return (
              <div className={`flex items-start gap-2.5 rounded-2xl border p-3 ${
                r.ok
                  ? 'border-ok/40 bg-ok-soft dark:bg-ok/10'
                  : 'border-crit/40 bg-crit-soft dark:bg-crit/10'}`}>
                {r.ok
                  ? <Check size={15} className="mt-px shrink-0 text-ok dark:text-ok-dark" />
                  : <AlertTriangle size={15} className="mt-px shrink-0 text-crit dark:text-crit-dark" />}
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium">
                    {p.name} · {p.model} — {r.ok ? `respondeu em ${r.ms} ms` : 'o teste falhou'}
                  </p>
                  {/* Quebra de linha de propósito: a mensagem do provedor é o
                      diagnóstico, e cortá-la esconde justamente o que resolve. */}
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {r.ok ? (r.sample || 'ok') : r.error}
                  </p>
                  {!r.ok && /no longer available|not found|does not exist|não encontrado/i.test(r.error ?? '') && (
                    <button onClick={() => setEditing(p)}
                      className="mt-1 text-[11.5px] font-medium text-info hover:underline dark:text-info-dark">
                      Escolher outro modelo — a lista da sua chave carrega sozinha
                    </button>
                  )}
                </div>
              </div>
            )
          })()}

          <div className="flex items-start gap-2.5 rounded-2xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
            <KeyRound size={14} strokeWidth={1.5} className="mt-px shrink-0 text-zinc-400" />
            <p className="text-[11px] leading-relaxed text-zinc-500">
              <b className="text-zinc-700 dark:text-zinc-300">Sobre as chaves.</b>{' '}
              São cifradas em repouso (AES-256-GCM) e nunca voltam numa resposta da API — a tela mostra
              apenas os quatro últimos caracteres, o bastante para você reconhecer qual é. Toda criação,
              edição e troca de padrão fica registrada na auditoria.
            </p>
          </div>
        </div>
      )}

      {editing && (
        <ProviderDialog
          secretConfigured={secretConfigured}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load() }}
        />
      )}
    </Page>
  )
}

// ── Formulário ─────────────────────────────────────────────────────────────
const INPUT = 'w-full rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[12px] transition-colors '
  + 'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 '
  + 'dark:border-zinc-800 dark:bg-zinc-950'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-zinc-500">{label}</span>
      {children}
      {hint && <span className="text-[10.5px] leading-snug text-zinc-400">{hint}</span>}
    </label>
  )
}

function ProviderDialog({ initial, secretConfigured, onClose, onSaved }: {
  initial: AiProvider | null
  /** Sem CONNECTIONS_SECRET nao ha como cifrar a chave — bloqueia o salvar. */
  secretConfigured: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial
  const [name, setName] = useState(initial?.name ?? '')
  const [kind, setKind] = useState<AiProviderKind>(initial?.kind ?? 'anthropic')
  const [model, setModel] = useState(initial?.model ?? 'claude-opus-5')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [maxTokens, setMaxTokens] = useState(String(initial?.maxTokens ?? 16000))
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false)
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Modelos REAIS da chave. Enquanto vazio, o campo usa a lista de sugestões.
  const [models, setModels] = useState<AiModelOption[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)

  const meta = kindOf(kind)

  // Buscar exige uma chave: a salva (ao editar) ou a digitada agora.
  const canListModels = !!apiKey.trim() || !!initial?.hasKey

  async function fetchModels() {
    setLoadingModels(true)
    setErr(null)
    try {
      const r = await api<{ models: AiModelOption[] }>('/api/v1/ai/providers/models', {
        method: 'POST',
        body: JSON.stringify({
          ...(initial ? { id: initial.id } : {}),
          kind,
          ...(apiKey ? { apiKey } : {}),
          baseUrl: baseUrl.trim() || null,
        }),
      })
      setModels(r.models)
      // Se o modelo atual não está na lista, assume o primeiro — evita salvar
      // um id que a chave não alcança (foi o que gerou o erro do Gemini).
      if (r.models.length && !r.models.some((m) => m.id === model)) setModel(r.models[0].id)
    } catch (e) {
      setErr((e as ApiError).message)
    } finally {
      setLoadingModels(false)
    }
  }

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  function pickKind(k: AiProviderKind) {
    setKind(k)
    setModels(null) // a lista era da chave/provedor anterior
    // LIMPA o modelo em vez de chutar um da lista fixa. Manter um modelo da
    // Anthropic ao mudar para Gemini geraria erro; escolher um sugerido gera
    // outro, mais sutil, quando a sugestão já saiu de circulação.
    if (!isEdit || !initial || initial.kind !== k) setModel('')
  }

  // Busca sozinho: ao abrir um provedor que já tem chave, e ~1s depois de a
  // pessoa terminar de colar uma. Listar modelos não custa token e valida a
  // chave de imediato — é o diagnóstico mais barato que existe aqui.
  useEffect(() => {
    if (!initial?.hasKey || apiKey) return
    void fetchModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.id])

  useEffect(() => {
    if (!apiKey.trim()) return
    const t = setTimeout(() => { void fetchModels() }, 900)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, kind])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await api(isEdit ? `/api/v1/ai/providers/${initial!.id}` : '/api/v1/ai/providers', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify({
          name, kind, model,
          // Ausente = mantém a chave atual; o backend só troca quando vem valor.
          ...(apiKey ? { apiKey } : {}),
          baseUrl: baseUrl.trim() || null,
          maxTokens: Number(maxTokens),
          enabled, isDefault,
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
        className="flex max-h-[92vh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card-lg dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2.5 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <Sparkles size={15} className="text-accent" />
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold">{isEdit ? 'Editar provedor' : 'Novo provedor de IA'}</h2>
            <p className="text-[10.5px] text-zinc-500">A chave é cifrada em repouso e nunca volta numa resposta.</p>
          </div>
          <button onClick={onClose} aria-label="Fechar" className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <Field label="Provedor">
            <div className="grid gap-1.5 sm:grid-cols-3">
              {KINDS.map((k) => (
                <button key={k.key} type="button" onClick={() => pickKind(k.key)}
                  className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    kind === k.key
                      ? 'border-accent bg-accent-soft dark:bg-accent/10'
                      : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800'}`}>
                  <span className="block text-[11.5px] font-medium">{k.label}</span>
                </button>
              ))}
            </div>
          </Field>
          <p className="mt-1.5 text-[10.5px] leading-snug text-zinc-500">{meta.hint}</p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Nome" hint="Como você reconhece este cadastro.">
              <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Claude de produção" />
            </Field>
            <Field
              label="Modelo"
              hint={models
                ? `${models.length} modelo(s) que esta chave alcança.`
                : 'A lista abaixo é só exemplo de formato e envelhece. Busque os modelos da chave para ver o que existe hoje.'}
            >
              {models && models.length > 0 ? (
                <select className={INPUT} value={model} onChange={(e) => setModel(e.target.value)}>
                  {/* O modelo salvo pode não estar na lista (chave trocada) —
                      mantém a opção para não perder o valor em silêncio. */}
                  {!models.some((m) => m.id === model) && model && (
                    <option value={model}>{model} (não listado)</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.label === m.id ? m.id : `${m.label} — ${m.id}`}</option>
                  ))}
                </select>
              ) : (
                <>
                  <input className={INPUT} value={model} onChange={(e) => setModel(e.target.value)} list="modelos" />
                  <datalist id="modelos">
                    {meta.models.map((m) => <option key={m} value={m} />)}
                  </datalist>
                </>
              )}
              <button
                type="button"
                onClick={() => void fetchModels()}
                disabled={loadingModels || !canListModels}
                title={canListModels ? undefined : 'Informe a chave primeiro'}
                className="mt-1 flex items-center gap-1 self-start text-[10.5px] font-medium text-info hover:underline disabled:opacity-50 disabled:no-underline dark:text-info-dark"
              >
                {loadingModels ? <Loader2 size={10} className="animate-spin" /> : <ListFilter size={10} />}
                {models ? 'Atualizar lista' : 'Buscar modelos da minha chave'}
              </button>
            </Field>
          </div>

          <div className="mt-3">
            <Field
              label="Chave de API"
              hint={initial?.hasKey
                ? `Já existe uma chave (termina em ${initial.keyHint ?? '••••'}). Deixe vazio para mantê-la.`
                : meta.keyHint}
            >
              <input className={INPUT} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                placeholder={initial?.hasKey ? '••••••••' : 'cole a chave aqui'} autoComplete="new-password" />
            </Field>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="URL base (opcional)" hint={meta.baseUrlHint ?? 'Use para apontar a um endpoint alternativo.'}>
              <input className={INPUT} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="deixe vazio para o padrão" />
            </Field>
            <Field label="Teto de tokens" hint="Resposta cortada no meio é a falha mais confusa — não economize aqui.">
              <input className={INPUT} type="number" min="256" max="128000" step="1000"
                value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
            </Field>
          </div>

          <div className="mt-3 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)}
                className="h-3.5 w-3.5 accent-accent" />
              Usar como padrão do time
            </label>
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
                className="h-3.5 w-3.5 accent-accent" />
              Disponível
            </label>
          </div>

          {!secretConfigured && (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-warn-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-warn dark:bg-warn/15 dark:text-warn-dark">
              <KeyRound size={13} className="mt-px shrink-0" />
              <span>
                <b>Não é possível salvar ainda.</b> Falta <code className="font-mono">CONNECTIONS_SECRET</code> na
                stack — é a chave que cifra a chave do provedor em repouso. Defina uma string longa e aleatória
                (<code className="font-mono">openssl rand -base64 48</code>), faça o redeploy e volte aqui.
              </span>
            </p>
          )}

          {err && (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-crit-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-crit dark:bg-crit/15 dark:text-crit-dark">
              <AlertTriangle size={13} className="mt-px shrink-0" /> {err}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            Cancelar
          </button>
          <button onClick={() => void save()} disabled={saving || !secretConfigured || !name || !model || (!isEdit && !apiKey)}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-accent-hover disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.4} />}
            {isEdit ? 'Salvar' : 'Cadastrar'}
          </button>
        </footer>
      </div>
    </div>
  )
}
