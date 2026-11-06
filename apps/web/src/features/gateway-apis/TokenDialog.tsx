// Um painel só para tudo o que um token pode: o que lê, onde escreve, quais
// serviços internos alcança e quanto pode chamar. Antes isso morava em duas
// telas (escopo em Integrações, limites no Gateway) e quem criava o token
// esquecia a segunda metade — daí os "tokens sem limite".
//
// O SEGREDO é imutável: editar muda só o entorno. Salvar são duas chamadas
// (credencial e política); se a segunda falhar depois de criar, o token novo
// aparece mesmo assim, com o aviso — ele já existe e só é mostrado uma vez.
import { useMemo, useState } from 'react'
import { KeyRound, Loader2, Check, Clock } from 'lucide-react'
import type { DatasetSummary, GatewayUpstream } from '@datahub/shared'
import { api } from '@/lib/api'
import {
  Dialog, Field, INPUT, ToggleChip, BTN_PRIMARY, BTN_SECONDARY, fmtDate, errMsg, type Credential,
} from './shared'

const KEEP = -1
const DAY_OPTS = [
  { v: 0, label: 'Sem validade' },
  { v: 30, label: '30 dias' },
  { v: 90, label: '90 dias' },
  { v: 180, label: '180 dias' },
  { v: 365, label: '1 ano' },
]

/** Opções conhecidas + as que o token já tem e saíram da lista. */
function withUnknown(known: { slug: string; name: string }[], picked: string[]) {
  const map = new Map(known.map((k) => [k.slug, k.name]))
  // Um escopo que aponta para algo fora da lista PRECISA aparecer marcado —
  // senão salvar a edição apagaria em silêncio o que ninguém pediu para tirar.
  for (const s of picked) if (!map.has(s)) map.set(s, `${s} (fora da lista)`)
  return [...map].map(([slug, name]) => ({ slug, name }))
}

const toggle = (list: string[], s: string) => (list.includes(s) ? list.filter((x) => x !== s) : [...list, s])
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

export interface TokenSaved { token?: string; warning?: string }

export default function TokenDialog({ initial, datasets, writeProducts, upstreams, onClose, onSaved }: {
  initial: Credential | null
  datasets: DatasetSummary[]
  writeProducts: { slug: string; name: string }[]
  upstreams: GatewayUpstream[]
  onClose: () => void
  onSaved: (r: TokenSaved) => void
}) {
  const isEdit = !!initial
  const [name, setName] = useState(initial?.name ?? '')
  const [days, setDays] = useState(isEdit ? KEEP : 0)
  const [slugs, setSlugs] = useState<string[]>(initial?.dataset_slugs ?? [])
  const [writeSlugs, setWriteSlugs] = useState<string[]>(initial?.write_slugs ?? [])
  const [upSlugs, setUpSlugs] = useState<string[]>(initial?.upstream_slugs ?? [])
  const [rate, setRate] = useState(initial?.rate_limit_per_min?.toString() ?? '')
  const [quota, setQuota] = useState(initial?.quota_per_day?.toString() ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const dsOpts = useMemo(() => withUnknown(datasets.map((d) => ({ slug: d.slug, name: d.name })), slugs), [datasets, slugs])
  const wrOpts = useMemo(() => withUnknown(writeProducts, writeSlugs), [writeProducts, writeSlugs])
  const upOpts = useMemo(() => withUnknown(upstreams.map((u) => ({ slug: u.slug, name: u.slug })), upSlugs), [upstreams, upSlugs])

  const policy = {
    rateLimitPerMin: rate === '' ? null : Number(rate),
    quotaPerDay: quota === '' ? null : Number(quota),
    upstreamSlugs: upSlugs,
  }
  const policyChanged = !initial
    ? policy.rateLimitPerMin !== null || policy.quotaPerDay !== null || upSlugs.length > 0
    : policy.rateLimitPerMin !== initial.rate_limit_per_min
      || policy.quotaPerDay !== initial.quota_per_day
      || !sameSet(upSlugs, initial.upstream_slugs ?? [])

  async function putPolicy(id: string) {
    await api(`/api/v1/gateway/credentials/${id}/policy`, { method: 'PUT', body: JSON.stringify(policy) })
  }

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      if (!initial) {
        const r = await api<{ id: string; token: string }>('/api/v1/credentials', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), datasetSlugs: slugs, writeSlugs, expiresInDays: days || undefined }),
        })
        let warning: string | undefined
        if (policyChanged) {
          try { await putPolicy(r.id) } catch (e) {
            warning = `O token foi criado, mas os limites não foram salvos (${errMsg(e)}). Abra a edição dele e salve de novo.`
          }
        }
        onSaved({ token: r.token, warning })
        return
      }
      await api(`/api/v1/credentials/${initial.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(), datasetSlugs: slugs, writeSlugs,
          // KEEP = não mexe (o campo nem vai). 0 = "sem validade" é escolha.
          ...(days === KEEP ? {} : { expiresInDays: days || null }),
        }),
      })
      if (policyChanged) await putPolicy(initial.id)
      onSaved({})
    } catch (e) {
      setErr(errMsg(e, 'Falha ao salvar.'))
    } finally {
      setSaving(false)
    }
  }

  const keepLabel = initial?.expires_at ? `Manter (até ${fmtDate(initial.expires_at)})` : 'Manter (sem validade)'

  return (
    <Dialog icon={KeyRound} width={640} onClose={onClose}
      title={isEdit ? `Token "${initial.name}"` : 'Novo token'}
      sub={isEdit ? 'O segredo não muda — só o que ele alcança e quanto pode chamar.' : 'O token aparece uma vez só, logo depois de gerado.'}
      footer={(
        <>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancelar</button>
          <button onClick={() => void save()} disabled={saving || !name.trim()} className={BTN_PRIMARY}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.4} />}
            {isEdit ? 'Salvar' : 'Gerar token'}
          </button>
        </>
      )}>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
        <Field label="Nome" hint="Quem usa e para quê. Ex.: Power BI — Diretoria.">
          <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} autoFocus />
        </Field>
        <Field label="Validade">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={INPUT}>
            {isEdit && <option value={KEEP}>{keepLabel}</option>}
            {DAY_OPTS.map((o) => <option key={o.v} value={o.v}>{isEdit && o.v ? `${o.label} a partir de hoje` : o.label}</option>)}
          </select>
        </Field>
      </div>

      <Section title="Leitura" hint="Nenhum marcado = todos os conjuntos. Vale também para as APIs de leitura (/p/…): só respondem se o conjunto delas estiver aqui.">
        {dsOpts.length === 0
          ? <p className="text-[11.5px] text-zinc-400">Nenhum conjunto sincronizado ainda.</p>
          : dsOpts.map((d) => (
            <ToggleChip key={d.slug} on={slugs.includes(d.slug)} onClick={() => setSlugs((p) => toggle(p, d.slug))}>{d.name}</ToggleChip>
          ))}
      </Section>

      {wrOpts.length > 0 && (
        <Section title="Escrita" hint="APIs de escrita (/w/…) que este token pode chamar. Nenhuma = só leitura.">
          {wrOpts.map((p) => (
            <ToggleChip key={p.slug} tone="crit" on={writeSlugs.includes(p.slug)} onClick={() => setWriteSlugs((s) => toggle(s, p.slug))}>{p.name}</ToggleChip>
          ))}
        </Section>
      )}

      <Section title="Serviços internos" hint="Serviços atrás do gateway (/gw/…). Acesso é opt-in: nada marcado = nenhum.">
        {upOpts.length === 0
          ? <p className="text-[11.5px] text-zinc-400">Nenhum serviço interno aprovado ainda.</p>
          : upOpts.map((u) => (
            <ToggleChip key={u.slug} mono on={upSlugs.includes(u.slug)} onClick={() => setUpSlugs((s) => toggle(s, u.slug))}>{u.name}</ToggleChip>
          ))}
      </Section>

      <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <p className="mb-2 text-[11.5px] font-semibold">Limites <span className="font-normal text-zinc-400">· vazio = sem limite</span></p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Requisições por minuto" hint="Protege o motor de um pico.">
            <input className={INPUT} type="number" min="1" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="sem limite" />
          </Field>
          <Field label="Cota diária" hint="Zera à meia-noite. Sobrevive a redeploy.">
            <input className={INPUT} type="number" min="1" value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="sem limite" />
          </Field>
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-snug text-zinc-400">
          <Clock size={12} className="mt-px shrink-0" />
          O limite por minuto é contado em memória e reinicia junto com o serviço; a cota diária fica no banco.
        </p>
      </div>

      {err && (
        <p className="mt-3 rounded-lg bg-crit-soft px-2.5 py-2 text-[11.5px] text-crit dark:bg-crit/15 dark:text-crit-dark">{err}</p>
      )}
    </Dialog>
  )
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="text-[11.5px] font-semibold">{title}</p>
      <p className="mb-1.5 text-[10.5px] leading-snug text-zinc-400">{hint}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}
