// Detalhe do Conjunto de Dados. Usuários veem campos e descrições; admins
// editam labels, ocultam campos, marcam sensíveis e pré-visualizam a amostra.
import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Eye, EyeOff, ShieldAlert, Table2, Loader2, Pencil, Check, Compass } from 'lucide-react'
import clsx from 'clsx'
import type { DatasetDetail, AdminDatasetField } from '@datahub/shared'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import SyncPanel from './SyncPanel'
import DataTable from './DataTable'

const TYPE_LABEL: Record<string, string> = {
  text: 'Texto', number: 'Número', date: 'Data', bool: 'Sim/Não', json: 'Estruturado',
}

export default function DatasetDetailPage() {
  const { slug } = useParams()
  const isAdmin = useAuthStore((s) => !!s.user?.roles.includes('admin'))
  const [dataset, setDataset] = useState<DatasetDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Record<string, unknown>[] | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [editingField, setEditingField] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')

  const load = useCallback(() => {
    api<{ dataset: DatasetDetail }>(`/api/v1/datasets/${slug}`)
      .then((r) => setDataset(r.dataset))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }, [slug])

  useEffect(() => { load() }, [load])

  async function patchField(field: AdminDatasetField, patch: Partial<AdminDatasetField>) {
    if (!dataset) return
    try {
      await api(`/api/v1/datasets/${dataset.id}/fields/${field.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar campo.')
    }
  }

  async function loadPreview() {
    if (!dataset) return
    setPreviewBusy(true)
    setPreview(null)
    try {
      const r = await api<{ rows: Record<string, unknown>[] }>(`/api/v1/datasets/${dataset.slug}/preview`)
      setPreview(r.rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha na pré-visualização.')
    } finally {
      setPreviewBusy(false)
    }
  }

  if (error && !dataset) {
    return (
      <div className="mx-auto max-w-4xl">
        <p className="rounded-lg bg-red-50 p-4 text-sm text-red-600 dark:bg-red-950/40">{error}</p>
      </div>
    )
  }
  if (!dataset) return <p className="text-sm text-zinc-500">Carregando…</p>

  const visibleFields = dataset.fields.filter((f) => !f.hidden)
  const previewColumns = preview?.length ? Object.keys(preview[0]) : []
  const labelByKey = new Map(dataset.fields.map((f) => [f.key, f.label]))

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/datasets" className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-accent">
        <ArrowLeft size={14} /> Catálogo
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{dataset.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">{dataset.description || 'Sem descrição.'}</p>
          <p className="mt-2 text-xs text-zinc-400">
            {visibleFields.length} campos · dono: {dataset.ownerEmail ?? '—'}
            {isAdmin && dataset.source && (
              <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-zinc-800">
                {dataset.source.connectionId}: {dataset.source.schema}.{dataset.source.table}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {dataset.lastSyncAt && (
            <Link
              to={`/datasets/${dataset.slug}/explore`}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover"
            >
              <Compass size={14} /> Explorar
            </Link>
          )}
          {isAdmin && (
            <button
              onClick={loadPreview}
              disabled={previewBusy}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              {previewBusy ? <Loader2 size={14} className="animate-spin" /> : <Table2 size={14} />}
              Preview da fonte
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>}

      {/* Campos */}
      <h2 className="mt-8 text-sm font-medium uppercase tracking-wider text-zinc-400">Campos</h2>
      <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2.5 font-medium">Campo</th>
              <th className="px-4 py-2.5 font-medium">Tipo</th>
              <th className="px-4 py-2.5 font-medium">Descrição</th>
              {isAdmin && <th className="px-4 py-2.5 text-right font-medium">Controles</th>}
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-zinc-950">
            {(isAdmin ? dataset.fields : visibleFields).map((f) => (
              <tr key={f.id} className={clsx('border-t border-zinc-100 dark:border-zinc-800', f.hidden && 'opacity-45')}>
                <td className="px-4 py-2">
                  {isAdmin && editingField === f.id ? (
                    <span className="flex items-center gap-1.5">
                      <input
                        autoFocus
                        value={labelDraft}
                        onChange={(e) => setLabelDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { patchField(f, { label: labelDraft }); setEditingField(null) } }}
                        className="rounded border border-zinc-300 px-2 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      />
                      <button onClick={() => { patchField(f, { label: labelDraft }); setEditingField(null) }} className="text-emerald-600"><Check size={15} /></button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 font-medium">
                      {f.label}
                      {f.sensitive && <ShieldAlert size={13} className="text-amber-500" />}
                      {isAdmin && (
                        <button
                          onClick={() => { setEditingField(f.id); setLabelDraft(f.label) }}
                          className="text-zinc-300 hover:text-accent dark:text-zinc-600"
                        >
                          <Pencil size={12} />
                        </button>
                      )}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-zinc-500">{TYPE_LABEL[f.type] ?? f.type}</td>
                <td className="px-4 py-2 text-zinc-500">{f.description ?? '—'}</td>
                {isAdmin && (
                  <td className="px-4 py-2 text-right">
                    <span className="inline-flex gap-1">
                      <button
                        title={f.hidden ? 'Exibir campo' : 'Ocultar campo'}
                        onClick={() => patchField(f, { hidden: !f.hidden })}
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
                      >
                        {f.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                      <button
                        title={f.sensitive ? 'Desmarcar sensível' : 'Marcar como sensível'}
                        onClick={() => patchField(f, { sensitive: !f.sensitive })}
                        className={clsx('rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                          f.sensitive ? 'text-amber-500' : 'text-zinc-400 hover:text-zinc-700')}
                      >
                        <ShieldAlert size={15} />
                      </button>
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sincronização com o lake (admin) */}
      {isAdmin && <SyncPanel dataset={dataset} onSynced={load} />}

      {/* Dados do lake — qualquer usuário, quando já sincronizado */}
      {dataset.lastSyncAt && <DataTable dataset={dataset} />}

      {/* Preview ao vivo da fonte (admin) */}
      {preview && (
        <>
          <h2 className="mt-8 text-sm font-medium uppercase tracking-wider text-zinc-400">
            Amostra (50 primeiras linhas, sensíveis mascarados)
          </h2>
          <div className="mt-3 max-h-96 overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                <tr>
                  {previewColumns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{labelByKey.get(c) ?? c}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-zinc-950">
                {preview.map((row, i) => (
                  <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                    {previewColumns.map((c) => (
                      <td key={c} className="max-w-[220px] truncate whitespace-nowrap px-3 py-1.5">
                        {row[c] === null || row[c] === undefined ? '—' : String(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
