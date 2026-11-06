// Serviço interno atrás do gateway (/gw/{slug}): o Data Hub repassa a chamada
// para um sistema da casa com token, cota e telemetria, sem o serviço mudar.
// Criado por editor entra pendente; por admin, já aprovado.
import { useState } from 'react'
import { Radio, Loader2, Check } from 'lucide-react'
import type { GatewayUpstream, GatewayAuthMode } from '@datahub/shared'
import { api } from '@/lib/api'
import { Dialog, Field, INPUT, METHOD_CLS, BTN_PRIMARY, BTN_SECONDARY, errMsg } from './shared'

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

export const AUTH_LABEL: Record<GatewayAuthMode, string> = {
  none: 'Sem autenticação',
  bearer: 'Bearer token',
  header: 'Header customizado',
  basic: 'Basic (usuário:senha)',
}

export default function UpstreamDialog({ initial, isAdmin, onClose, onSaved }: {
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
      setErr(errMsg(e, 'Falha ao salvar.'))
    } finally {
      setSaving(false)
    }
  }

  const sub = !isEdit
    ? (isAdmin ? 'Entra já aprovado.' : 'Entra como pendente até um administrador aprovar.')
    : initial!.status === 'active' && !isAdmin
      // SEG-04: a aprovação cobre destino, credencial e métodos.
      ? 'Mudar endereço, autenticação, segredo ou métodos devolve o serviço para aprovação — ele sai do ar até um administrador aprovar de novo.'
      : initial!.status === 'active'
        ? 'Sua edição vale como a nova aprovação.'
        : 'Segue pendente até um administrador aprovar.'

  return (
    <Dialog icon={Radio} title={isEdit ? 'Editar serviço interno' : 'Novo serviço interno'} sub={sub} onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancelar</button>
          <button onClick={() => void save()} disabled={saving || !name || !slug || !baseUrl || !methods.length} className={BTN_PRIMARY}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.4} />}
            {isEdit ? 'Salvar' : 'Registrar'}
          </button>
        </>
      )}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome">
          <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Estoque de equipamentos" autoFocus />
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
        <Field label="Métodos permitidos" group>
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
        <Field label="Prefixo" group>
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
    </Dialog>
  )
}
