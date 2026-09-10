// Integrações: tokens de acesso (Power BI, Sheets, API REST) com exemplos
// prontos. O token em claro aparece UMA vez — depois só o hash existe.
//
// O SEGREDO é imutável, mas o entorno não: nome, escopo, validade e o
// liga/desliga se editam a qualquer momento. E revogar ≠ excluir —
//   revogar  para de funcionar, fica na lista, preserva o histórico de uso;
//   excluir  some de vez, para o token criado por engano ou a integração morta.
//
// A lista é TABELA, não pilha de cartões: um token se compara com os outros por
// escopo, uso e validade, e isso só se lê em colunas alinhadas. Em cartão o
// nome ficava à esquerda, os ícones a mil pixels de distância na direita, e o
// meio vazio.
import { useEffect, useMemo, useState } from 'react'
import {
  Plug, Plus, Copy, Check, Trash2, Loader2, Pencil, Ban, RotateCcw, X, Link2,
} from 'lucide-react'
import type { DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useConfirm } from '@/components/Dialogs'
import { Page, PageHeader, PrimaryButton, ErrorBanner, EmptyState } from '@/components/ui/Page'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td, EntityCell } from '@/components/ui/DataGrid'
import { Pill } from '@/components/ui/Pill'

interface Credential {
  id: string; name: string; dataset_slugs: string[]; write_slugs?: string[]
  owner_email: string; revoked: boolean
  last_used_at: string | null; expires_at: string | null; created_at: string
}
interface WriteProduct { id: string; slug: string; name: string }

const DAY_OPTS = [
  { v: 0, label: 'Sem validade' },
  { v: 30, label: '30 dias' },
  { v: 90, label: '90 dias' },
  { v: 180, label: '180 dias' },
  { v: 365, label: '1 ano' },
]

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR')

export default function IntegrationsPage() {
  const user = useAuthStore((s) => s.user)
  const confirm = useConfirm()
  const canEdit = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const isAdmin = !!user?.roles.includes('admin')

  const [credentials, setCredentials] = useState<Credential[] | null>(null)
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [writeProducts, setWriteProducts] = useState<WriteProduct[]>([])
  const [error, setError] = useState<string | null>(null)

  // null = fechado · 'new' = criando · Credential = editando aquele token
  const [form, setForm] = useState<'new' | Credential | null>(null)
  const [fName, setFName] = useState('')
  const [fSlugs, setFSlugs] = useState<string[]>([])
  const [fWriteSlugs, setFWriteSlugs] = useState<string[]>([])
  const [fDays, setFDays] = useState(0)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  function load() {
    api<{ credentials: Credential[] }>('/api/v1/credentials')
      .then((r) => setCredentials(r.credentials))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }
  useEffect(() => {
    load()
    api<{ datasets: DatasetSummary[] }>('/api/v1/datasets')
      .then((r) => setDatasets(r.datasets.filter((d) => d.lastSyncAt))).catch(() => {})
    if (isAdmin) {
      api<{ products: (WriteProduct & { kind: string; status: string })[] }>('/api/v1/products')
        .then((r) => setWriteProducts(r.products.filter((p) => p.kind === 'write' && p.status === 'active')))
        .catch(() => {})
    }
  }, [isAdmin])

  function openCreate() {
    setForm('new'); setFName(''); setFSlugs([]); setFWriteSlugs([]); setFDays(0); setError(null)
  }
  function openEdit(c: Credential) {
    setForm(c); setFName(c.name); setFSlugs(c.dataset_slugs ?? [])
    setFWriteSlugs(c.write_slugs ?? []); setFDays(0); setError(null)
  }

  // Um token pode apontar para um conjunto que saiu da lista (nunca
  // sincronizado, ou removido). Ele PRECISA aparecer marcado — senão salvar a
  // edição apagaria em silêncio um escopo que a pessoa não pediu para tirar.
  const slugOptions = useMemo(() => {
    const known = new Map(datasets.map((d) => [d.slug, d.name]))
    for (const s of fSlugs) if (!known.has(s)) known.set(s, `${s} (fora da lista)`)
    return [...known].map(([slug, name]) => ({ slug, name }))
  }, [datasets, fSlugs])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      if (form === 'new') {
        const r = await api<{ token: string }>('/api/v1/credentials', {
          method: 'POST',
          body: JSON.stringify({
            name: fName, datasetSlugs: fSlugs,
            writeSlugs: isAdmin ? fWriteSlugs : [],
            expiresInDays: fDays || undefined,
          }),
        })
        setNewToken(r.token)
      } else if (form) {
        await api(`/api/v1/credentials/${form.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: fName, datasetSlugs: fSlugs,
            // Só admin pode mandar este campo — o backend recusa dos demais.
            ...(isAdmin ? { writeSlugs: fWriteSlugs } : {}),
            // 0 = "sem validade" é uma escolha, não "não mexer".
            expiresInDays: fDays || null,
          }),
        })
      }
      setForm(null)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  async function setRevoked(c: Credential, revoked: boolean) {
    if (revoked && !(await confirm({
      title: 'Revogar token',
      message: `"${c.name}" deixa de funcionar imediatamente e as integrações que o usam vão parar. Ele continua na lista e pode ser reativado depois.`,
      danger: true, confirmLabel: 'Revogar',
    }))) return
    setBusyId(c.id)
    try {
      await api(`/api/v1/credentials/${c.id}`, { method: 'PATCH', body: JSON.stringify({ revoked }) })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao alterar o token.')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(c: Credential) {
    if (!(await confirm({
      title: 'Excluir token',
      message: `"${c.name}" será apagado definitivamente e some da lista. Quem ainda estiver usando esse token recebe erro de autenticação. O histórico de chamadas continua no monitoramento. Não dá para desfazer.`,
      danger: true, confirmLabel: 'Excluir',
    }))) return
    setBusyId(c.id)
    try {
      await api(`/api/v1/credentials/${c.id}`, { method: 'DELETE' })
      setCredentials((cur) => (cur ?? []).filter((x) => x.id !== c.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao excluir.')
    } finally {
      setBusyId(null)
    }
  }

  function copy(text: string, key: string) {
    void navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  // Template generico (com placeholders), nao a URL de um conjunto real --
  // troque {SEU_DATASET} e {SEU_TOKEN} pelos valores reais ao usar.
  const restUrl = `${window.location.host}/api/public/v1/datasets/{SEU_DATASET}/rows?token={SEU_TOKEN}`
  const csvUrl = `${restUrl}&format=csv`

  const inputCls = 'w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[12px] dark:border-zinc-700 dark:bg-zinc-950'
  const iconBtn = 'rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'

  return (
    <Page>
      <PageHeader
        icon={Plug}
        title="Integrações"
        subtitle="Tokens de leitura via API JSON ou exportação CSV."
      >
        {canEdit && <PrimaryButton icon={Plus} onClick={openCreate}>Novo token</PrimaryButton>}
      </PageHeader>

      {error && <ErrorBanner message={error} />}

      {/* Token recém-criado — única exibição */}
      {newToken && (
        <div className="mb-2.5 rounded-2xl border border-warn/50 bg-warn-soft p-3 dark:bg-warn/10">
          <p className="text-[12px] font-semibold text-warn dark:text-warn-dark">
            Copie o token agora — ele não será mostrado novamente.
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Guardamos só o hash. Se perder, o caminho é excluir este e gerar outro.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-white px-3 py-2 font-mono text-[11px] dark:bg-zinc-900">{newToken}</code>
            <button onClick={() => copy(newToken, 'new')}
              className="shrink-0 rounded-lg border border-warn/50 p-2 text-warn hover:bg-warn-soft dark:text-warn-dark">
              {copied === 'new' ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <button onClick={() => setNewToken(null)} className="mt-2 text-[11px] text-zinc-500 underline">
            Já copiei, pode esconder
          </button>
        </div>
      )}

      {/* Formulário — o mesmo para criar e para editar */}
      {form && (
        <Card className="mb-2.5">
          <CardHead icon={form === 'new' ? Plus : Pencil}
            title={form === 'new' ? 'Novo token' : `Editar "${form.name}"`}
            sub={form === 'new' ? undefined : 'o segredo não muda — só o entorno'}>
            <button onClick={() => setForm(null)} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
              <X size={15} />
            </button>
          </CardHead>

          <div className="grid gap-3 p-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
              <label className="block min-w-0">
                <span className="mb-1 block text-[11px] text-zinc-500">Nome (ex.: Power BI — Diretoria)</span>
                <input value={fName} onChange={(e) => setFName(e.target.value)} className={inputCls} autoFocus />
              </label>
              <label className="block min-w-0">
                <span className="mb-1 block text-[11px] text-zinc-500">
                  Validade{form !== 'new' && form.expires_at ? ` · hoje até ${fmtDate(form.expires_at)}` : ''}
                </span>
                <select value={fDays} onChange={(e) => setFDays(Number(e.target.value))}
                  className={`${inputCls} bg-white dark:bg-zinc-950`}>
                  {DAY_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
              </label>
            </div>

            <div>
              <span className="mb-1.5 block text-[11px] text-zinc-500">
                Conjuntos permitidos <span className="text-zinc-400">(nenhum marcado = todos)</span>
              </span>
              <div className="flex flex-wrap gap-1.5">
                {slugOptions.length === 0 && (
                  <p className="text-[11px] text-zinc-400">Nenhum conjunto sincronizado ainda.</p>
                )}
                {slugOptions.map((d) => (
                  <label key={d.slug}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${fSlugs.includes(d.slug)
                      ? 'border-accent bg-accent-soft dark:bg-zinc-800'
                      : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700'}`}>
                    <input type="checkbox" className="h-3 w-3 accent-accent" checked={fSlugs.includes(d.slug)}
                      onChange={(e) => setFSlugs((prev) => e.target.checked
                        ? [...prev, d.slug] : prev.filter((s) => s !== d.slug))} />
                    {d.name}
                  </label>
                ))}
              </div>
            </div>

            {isAdmin && writeProducts.length > 0 && (
              <div>
                <span className="mb-1.5 block text-[11px] text-zinc-500">
                  APIs de <strong>escrita</strong> <span className="text-zinc-400">(só admin concede — nenhuma = só leitura)</span>
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {writeProducts.map((p) => (
                    <label key={p.slug}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${fWriteSlugs.includes(p.slug)
                        ? 'border-crit bg-crit-soft dark:bg-crit/10'
                        : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700'}`}>
                      <input type="checkbox" className="h-3 w-3 accent-crit" checked={fWriteSlugs.includes(p.slug)}
                        onChange={(e) => setFWriteSlugs((prev) => e.target.checked
                          ? [...prev, p.slug] : prev.filter((s) => s !== p.slug))} />
                      {p.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <PrimaryButton onClick={() => void save()} disabled={saving || !fName.trim()}>
                {saving && <Loader2 size={13} className="animate-spin" />}
                {form === 'new' ? 'Gerar token' : 'Salvar'}
              </PrimaryButton>
              <button onClick={() => setForm(null)} className="text-[12px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                Cancelar
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* Tokens existentes */}
      <Card>
        <CardHead icon={Plug} title="Tokens" sub={credentials ? String(credentials.length) : undefined} />
        {credentials === null && !error ? (
          <p className="px-3 py-8 text-center text-[12px] text-zinc-500">Carregando…</p>
        ) : credentials?.length === 0 ? (
          <EmptyState
            icon={Plug}
            message={`Nenhum token ainda.${canEdit ? ' Gere o primeiro para consumir a API ou exportar CSV.' : ''}`}
            action={canEdit ? (
              <button onClick={openCreate} className="text-[12px] font-medium text-info hover:underline dark:text-info-dark">
                Criar o primeiro
              </button>
            ) : undefined}
          />
        ) : (
          <DataGrid>
            <thead>
              <tr>
                <Th>Token</Th>
                <Th>Conjuntos</Th>
                <Th className="w-[112px]">Último uso</Th>
                <Th className="w-[112px]">Validade</Th>
                <Th className="w-[100px]">Situação</Th>
                <Th right className="w-[92px]"><span className="sr-only">Ações</span></Th>
              </tr>
            </thead>
            <tbody>
              {credentials?.map((c) => {
                const mine = c.owner_email === user?.email || isAdmin
                const expired = !!c.expires_at && new Date(c.expires_at).getTime() < Date.now()
                const busy = busyId === c.id
                const escopo = c.dataset_slugs.length ? c.dataset_slugs.join(', ') : 'todos os conjuntos'
                return (
                  <Tr key={c.id}>
                    <Td>
                      <EntityCell
                        name={c.name}
                        slug={c.owner_email === user?.email ? 'você' : c.owner_email}
                      >
                        <Plug size={13} strokeWidth={1.5}
                          className={c.revoked || expired ? 'shrink-0 text-zinc-300 dark:text-zinc-600' : 'shrink-0 text-accent'} />
                      </EntityCell>
                    </Td>
                    <Td className="max-w-[280px]">
                      <span className="block truncate" title={escopo}>{escopo}</span>
                      {!!c.write_slugs?.length && (
                        <span className="block truncate text-[10px] text-crit dark:text-crit-dark"
                          title={c.write_slugs.join(', ')}>
                          escrita: {c.write_slugs.join(', ')}
                        </span>
                      )}
                    </Td>
                    <Td muted>{c.last_used_at ? fmtDate(c.last_used_at) : 'nunca'}</Td>
                    <Td muted>{c.expires_at ? fmtDate(c.expires_at) : '—'}</Td>
                    <Td>
                      {c.revoked
                        ? <Pill>revogado</Pill>
                        : expired
                          ? <Pill tone="warn">expirado</Pill>
                          : <Pill tone="ok">ativo</Pill>}
                    </Td>
                    <Td right>
                      {canEdit && (
                        <span className="flex items-center justify-end gap-0.5">
                          {busy && <Loader2 size={12} className="animate-spin text-zinc-400" />}
                          <button onClick={() => openEdit(c)} className={iconBtn}
                            title="Editar nome, conjuntos e validade">
                            <Pencil size={13} strokeWidth={1.6} />
                          </button>
                          <button onClick={() => void setRevoked(c, !c.revoked)} disabled={busy} className={iconBtn}
                            title={c.revoked ? 'Reativar token' : 'Revogar — para de funcionar, mas fica no histórico'}>
                            {c.revoked ? <RotateCcw size={13} strokeWidth={1.6} /> : <Ban size={13} strokeWidth={1.6} />}
                          </button>
                          {/* Excluir é definitivo: só o dono ou um admin. Os demais revogam. */}
                          {mine && (
                            <button onClick={() => void remove(c)} disabled={busy} title="Excluir definitivamente"
                              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-crit-soft hover:text-crit disabled:opacity-40 dark:hover:bg-crit/10 dark:hover:text-crit-dark">
                              <Trash2 size={13} strokeWidth={1.6} />
                            </button>
                          )}
                        </span>
                      )}
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataGrid>
        )}
      </Card>

      {/* Exemplos de uso */}
      <Card className="mt-2.5">
        <CardHead icon={Link2} title="Como conectar" sub="troque {SEU_DATASET} e {SEU_TOKEN} pelos valores reais" />
        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {[
            { title: 'API REST (JSON paginado)', hint: 'Suporta ?limit= e ?offset= — ideal para scripts e apps.', url: restUrl, key: 'rest' },
            { title: 'Exportação CSV', hint: 'Abre direto no Excel/Sheets. No Sheets: =IMPORTDATA("url"). No Excel: Dados → Da Web.', url: csvUrl, key: 'csv' },
          ].map((ex) => (
            <div key={ex.key} className="grid items-center gap-2 p-3 lg:grid-cols-[260px_minmax(0,1fr)]">
              <div className="min-w-0">
                <p className="text-[12px] font-medium">{ex.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{ex.hint}</p>
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-zinc-50 px-2.5 py-1.5 font-mono text-[11px] dark:bg-zinc-950">{ex.url}</code>
                <button onClick={() => copy(ex.url, ex.key)} className={iconBtn} title="Copiar URL">
                  {copied === ex.key ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </Page>
  )
}
