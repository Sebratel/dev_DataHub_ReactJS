// Integrações: geração de tokens de acesso (Power BI, Sheets, API REST) com
// exemplos prontos. O token em claro aparece UMA vez — depois só o hash existe.
import { useEffect, useState } from 'react'
import { Plug, Plus, Copy, Check, Trash2, Loader2 } from 'lucide-react'
import type { DatasetSummary } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'

interface Credential {
  id: string; name: string; dataset_slugs: string[]; owner_email: string
  revoked: boolean; last_used_at: string | null; expires_at: string | null; created_at: string
}

export default function IntegrationsPage() {
  const user = useAuthStore((s) => s.user)
  const canEdit = !!user?.roles.some((r) => r === 'admin' || r === 'editor')
  const [credentials, setCredentials] = useState<Credential[] | null>(null)
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [fName, setFName] = useState('')
  const [fSlugs, setFSlugs] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
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
  }, [])

  async function create() {
    setSaving(true)
    setError(null)
    try {
      const r = await api<{ token: string }>('/api/v1/credentials', {
        method: 'POST',
        body: JSON.stringify({ name: fName, datasetSlugs: fSlugs }),
      })
      setNewToken(r.token)
      setShowForm(false)
      setFName(''); setFSlugs([])
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao criar token.')
    } finally {
      setSaving(false)
    }
  }

  async function revoke(c: Credential) {
    if (!window.confirm(`Revogar o token "${c.name}"? Integrações que o usam vão parar.`)) return
    await api(`/api/v1/credentials/${c.id}`, { method: 'DELETE' }).catch(() => {})
    load()
  }

  function copy(text: string, key: string) {
    void navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  const baseUrl = window.location.origin
  const exampleSlug = datasets[0]?.slug ?? '<slug-do-conjunto>'
  const restUrl = `${baseUrl}/api/public/v1/datasets/${exampleSlug}/rows?token=SEU_TOKEN`
  const csvUrl = `${restUrl}&format=csv`

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Integrações</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Tokens de leitura para Power BI, Google Sheets, Excel e API REST.
          </p>
        </div>
        {canEdit && (
          <button onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-zinc-950 hover:bg-accent-hover">
            <Plus size={15} /> Novo token
          </button>
        )}
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      {/* Token recém-criado — única exibição */}
      {newToken && (
        <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            Copie o token agora — ele não será mostrado novamente:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg bg-white px-3 py-2 font-mono text-xs dark:bg-zinc-900">{newToken}</code>
            <button onClick={() => copy(newToken, 'new')}
              className="rounded-lg border border-amber-300 p-2 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300">
              {copied === 'new' ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <button onClick={() => setNewToken(null)} className="mt-2 text-xs text-amber-700 underline dark:text-amber-400">
            Já copiei, pode esconder
          </button>
        </div>
      )}

      {showForm && (
        <div className="mt-5 grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Nome (ex.: Power BI — Diretoria)</span>
            <input value={fName} onChange={(e) => setFName(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
          </label>
          <div className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">
              Conjuntos permitidos (nenhum marcado = todos)
            </span>
            <div className="flex flex-wrap gap-2">
              {datasets.map((d) => (
                <label key={d.slug} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1 text-xs dark:border-zinc-700">
                  <input type="checkbox" checked={fSlugs.includes(d.slug)}
                    onChange={(e) => setFSlugs((prev) => e.target.checked ? [...prev, d.slug] : prev.filter((s) => s !== d.slug))} />
                  {d.name}
                </label>
              ))}
            </div>
          </div>
          <button onClick={create} disabled={saving || !fName}
            className="flex w-fit items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />} Gerar token
          </button>
        </div>
      )}

      {/* Tokens existentes */}
      <div className="mt-6 grid gap-2">
        {credentials === null && !error && <p className="text-sm text-zinc-500">Carregando…</p>}
        {credentials?.length === 0 && (
          <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Nenhum token ainda.{canEdit ? ' Gere o primeiro para conectar o Power BI ou o Sheets.' : ''}
          </div>
        )}
        {credentials?.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <Plug size={16} className={c.revoked ? 'text-zinc-300' : 'text-accent'} />
            <div className="min-w-0 flex-1">
              <p className={`font-medium ${c.revoked ? 'text-zinc-400 line-through' : ''}`}>{c.name}</p>
              <p className="text-xs text-zinc-500">
                {c.dataset_slugs.length ? c.dataset_slugs.join(', ') : 'todos os conjuntos'}
                {c.last_used_at && ` · último uso ${new Date(c.last_used_at).toLocaleDateString('pt-BR')}`}
                {c.revoked && ' · revogado'}
              </p>
            </div>
            {canEdit && !c.revoked && (
              <button onClick={() => revoke(c)} className="text-zinc-300 hover:text-red-500 dark:text-zinc-600" title="Revogar">
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Exemplos de uso */}
      <h2 className="mt-8 text-sm font-medium uppercase tracking-wider text-zinc-400">Como conectar</h2>
      <div className="mt-3 grid gap-3">
        {[
          { title: 'API REST (JSON paginado)', hint: 'Suporta ?limit=&offset= — ideal para scripts e apps.', url: restUrl, key: 'rest' },
          { title: 'Google Sheets / Excel (CSV)', hint: 'No Sheets: =IMPORTDATA("url"). No Excel: Dados → Da Web.', url: csvUrl, key: 'csv' },
          { title: 'Power BI (Web connector)', hint: 'Obter Dados → Web → cole a URL JSON. O Power BI expande as linhas.', url: restUrl, key: 'pbi' },
        ].map((ex) => (
          <div key={ex.key} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm font-medium">{ex.title}</p>
            <p className="mt-0.5 text-xs text-zinc-500">{ex.hint}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-zinc-50 px-3 py-2 font-mono text-[11px] dark:bg-zinc-950">{ex.url}</code>
              <button onClick={() => copy(ex.url, ex.key)}
                className="rounded-lg border border-zinc-200 p-2 text-zinc-500 hover:text-accent dark:border-zinc-700">
                {copied === ex.key ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
