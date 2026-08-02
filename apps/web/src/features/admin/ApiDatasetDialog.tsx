// Publica um dataset a partir de uma conexão HTTP: endpoint + params + paginação.
// O backend puxa uma amostra, infere os campos e cria o conjunto.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Loader2 } from 'lucide-react'
import type { ConnectionInfo } from '@datahub/shared'
import { api } from '@/lib/api'

interface Props {
  connection: ConnectionInfo
  onClose: () => void
}

type PagStyle = 'none' | 'page' | 'offset' | 'cursor'

export default function ApiDatasetDialog({ connection, onClose }: Props) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [recordsPath, setRecordsPath] = useState('')
  const [queryText, setQueryText] = useState('')
  const [pag, setPag] = useState<PagStyle>('none')
  const [pageParam, setPageParam] = useState('page')
  const [sizeParam, setSizeParam] = useState('per_page')
  const [size, setSize] = useState('100')
  // cursor
  const [cursorMode, setCursorMode] = useState<'body' | 'link'>('body')
  const [cursorParam, setCursorParam] = useState('cursor')
  const [cursorPath, setCursorPath] = useState('meta.next')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function parseQuery(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of queryText.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return out
  }

  async function publish() {
    if (!path.trim()) { setError('Informe o caminho do endpoint.'); return }
    setBusy(true); setError(null)
    try {
      const pagination = pag === 'none' ? { style: 'none' }
        : pag === 'cursor' ? {
          style: 'cursor',
          pageParam: cursorMode === 'body' ? (cursorParam.trim() || 'cursor') : undefined,
          cursorPath: cursorMode === 'body' ? (cursorPath.trim() || undefined) : undefined,
          linkHeader: cursorMode === 'link' ? true : undefined,
          sizeParam: sizeParam.trim() || undefined,
          size: Number(size) || undefined,
        }
        : {
          style: pag,
          pageParam: pageParam.trim() || (pag === 'offset' ? 'offset' : 'page'),
          sizeParam: sizeParam.trim() || undefined,
          size: Number(size) || undefined,
          start: pag === 'offset' ? 0 : 1,
        }
      const r = await api<{ slug: string }>('/api/v1/datasets/http', {
        method: 'POST',
        body: JSON.stringify({
          connectionId: connection.id,
          name: name.trim() || path.trim(),
          path: path.trim(),
          recordsPath: recordsPath.trim() || undefined,
          query: parseQuery(),
          pagination,
        }),
      })
      navigate(`/datasets/${r.slug}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao publicar.'); setBusy(false)
    }
  }

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-semibold">Publicar dataset de API</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        <p className="mb-4 text-xs text-zinc-500">Conexão: <span className="font-mono">{connection.name}</span> · {connection.http?.baseUrl}</p>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Nome do conjunto</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inp} placeholder="Ex.: Clientes (API)" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Caminho do endpoint</span>
              <input value={path} onChange={(e) => setPath(e.target.value)} className={inp} placeholder="/clientes" />
            </label>
          </div>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">
              Caminho dos registros <span className="text-zinc-400">(onde está o array no JSON; vazio = raiz)</span>
            </span>
            <input value={recordsPath} onChange={(e) => setRecordsPath(e.target.value)} className={inp} placeholder="data  ou  result.items" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Parâmetros fixos <span className="text-zinc-400">(um por linha: chave=valor)</span></span>
            <textarea value={queryText} onChange={(e) => setQueryText(e.target.value)} rows={2} className={inp} placeholder={'status=ativo\nregiao=sul'} />
          </label>

          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Paginação</span>
              <select value={pag} onChange={(e) => setPag(e.target.value as PagStyle)} className={inp}>
                <option value="none">Sem paginação (uma resposta)</option>
                <option value="page">Por página (?page=1&amp;per_page=100)</option>
                <option value="offset">Por offset (?offset=0&amp;limit=100)</option>
                <option value="cursor">Por cursor / Link header</option>
              </select>
            </label>
            {(pag === 'page' || pag === 'offset') && (
              <div className="mt-2 grid grid-cols-3 gap-2">
                <label className="text-xs text-zinc-500">Param {pag === 'offset' ? 'offset' : 'página'}
                  <input value={pageParam} onChange={(e) => setPageParam(e.target.value)} className={inp} placeholder={pag === 'offset' ? 'offset' : 'page'} />
                </label>
                <label className="text-xs text-zinc-500">Param tamanho
                  <input value={sizeParam} onChange={(e) => setSizeParam(e.target.value)} className={inp} placeholder="per_page" />
                </label>
                <label className="text-xs text-zinc-500">Tamanho
                  <input value={size} onChange={(e) => setSize(e.target.value)} className={inp} inputMode="numeric" />
                </label>
              </div>
            )}
            {pag === 'cursor' && (
              <div className="mt-2 grid gap-2">
                <label className="text-xs text-zinc-500">Origem do cursor
                  <select value={cursorMode} onChange={(e) => setCursorMode(e.target.value as 'body' | 'link')} className={inp}>
                    <option value="body">No corpo da resposta (campo)</option>
                    <option value="link">No header Link (rel="next")</option>
                  </select>
                </label>
                {cursorMode === 'body' && (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs text-zinc-500">Param que envia o cursor
                      <input value={cursorParam} onChange={(e) => setCursorParam(e.target.value)} className={inp} placeholder="cursor" />
                    </label>
                    <label className="text-xs text-zinc-500">Campo do próximo cursor
                      <input value={cursorPath} onChange={(e) => setCursorPath(e.target.value)} className={inp} placeholder="meta.next" />
                    </label>
                  </div>
                )}
                {cursorMode === 'link' && (
                  <p className="text-xs text-zinc-400">A próxima página vem do header <span className="font-mono">Link; rel="next"</span> — nada mais a configurar.</p>
                )}
              </div>
            )}
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={publish} disabled={busy}
            className="mt-1 flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />} Puxar amostra e publicar
          </button>
        </div>
      </div>
    </div>
  )
}
