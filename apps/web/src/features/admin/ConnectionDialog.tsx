// Diálogo de conexão gerenciada (criar/editar) com teste antes de salvar.
// Suporta banco (Postgres/MySQL) e API HTTP. A senha/token nunca vem preenchida
// na edição; em branco no update = mantém o atual.
import { useState } from 'react'
import { X, Loader2, CheckCircle2, XCircle, Plug } from 'lucide-react'
import type { ConnectionInfo } from '@datahub/shared'
import { api } from '@/lib/api'

interface Props {
  existing?: ConnectionInfo | null // presente = edição
  onClose: () => void
  onSaved: () => void
}

type Kind = 'postgres' | 'mysql' | 'http'

export default function ConnectionDialog({ existing, onClose, onSaved }: Props) {
  const isEdit = !!existing
  const d = existing?.detail
  const h = existing?.http
  const [name, setName] = useState(existing?.name ?? '')
  const [kind, setKind] = useState<Kind>((existing?.kind as Kind) ?? 'postgres')
  // Banco
  const [host, setHost] = useState(d?.host ?? '')
  const [port, setPort] = useState<string>(d ? String(d.port) : '')
  const [database, setDatabase] = useState(d?.database ?? '')
  const [username, setUsername] = useState(d?.username ?? '')
  const [ssl, setSsl] = useState(d?.ssl ?? false)
  const [writable, setWritable] = useState(existing?.writable ?? false)
  // HTTP
  const [baseUrl, setBaseUrl] = useState(h?.baseUrl ?? '')
  const [authHeader, setAuthHeader] = useState(h?.authHeader ?? 'Authorization')
  const [authScheme, setAuthScheme] = useState(h?.authScheme ?? 'Bearer')
  // Segredo (senha ou token)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; status?: number; error?: string } | null>(null)

  const isHttp = kind === 'http'
  const defaultPort = kind === 'mysql' ? 3306 : 5432

  function body() {
    if (isHttp) {
      return { name: name.trim(), kind, ssl: false, baseUrl: baseUrl.trim(), authHeader: authHeader.trim() || undefined, authScheme: authScheme.trim() || undefined, token: secret || undefined }
    }
    return { name: name.trim(), kind, host: host.trim(), port: Number(port) || defaultPort, database: database.trim(), username: username.trim(), password: secret || undefined, ssl, writable }
  }
  const valid = isHttp
    ? name.trim() && /^https?:\/\//i.test(baseUrl.trim())
    : name.trim() && host.trim() && database.trim() && username.trim() && (isEdit || secret)

  async function test() {
    setBusy(true); setError(null); setTestResult(null)
    try {
      if (!isHttp && !secret) { setError('Informe a senha para testar.'); return }
      const r = await api<{ ok: boolean; latencyMs: number; status?: number; error?: string }>('/api/v1/connections/test', {
        method: 'POST', body: JSON.stringify(body()),
      })
      setTestResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao testar.')
    } finally { setBusy(false) }
  }

  async function save() {
    setBusy(true); setError(null)
    try {
      if (isEdit) await api(`/api/v1/connections/${existing!.id}`, { method: 'PATCH', body: JSON.stringify(body()) })
      else await api('/api/v1/connections', { method: 'POST', body: JSON.stringify(body()) })
      onSaved(); onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar.'); setBusy(false)
    }
  }

  const inp = 'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{isEdit ? 'Editar conexão' : 'Nova conexão'}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X size={17} /></button>
        </div>
        <div className="grid gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inp} placeholder="Ex.: ERP Financeiro" autoFocus />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-zinc-500">Tipo</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={inp} disabled={isEdit}>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL/MariaDB</option>
              <option value="http">API HTTP (GET)</option>
            </select>
          </label>

          {isHttp ? (
            <>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">Base URL</span>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={inp} placeholder="https://api.empresa.com/v1" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm">
                  <span className="mb-1 block text-xs text-zinc-500">Header de auth</span>
                  <input value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} className={inp} placeholder="Authorization" />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-xs text-zinc-500">Prefixo (opcional)</span>
                  <input value={authScheme} onChange={(e) => setAuthScheme(e.target.value)} className={inp} placeholder="Bearer" />
                </label>
              </div>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">
                  Token {isEdit && <span className="text-zinc-400">(em branco = mantém o atual)</span>}
                </span>
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className={inp} autoComplete="new-password" placeholder={isEdit ? '••••••••' : ''} />
              </label>
            </>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-sm">
                  <span className="mb-1 block text-xs text-zinc-500">Porta</span>
                  <input value={port} onChange={(e) => setPort(e.target.value)} className={inp} placeholder={String(defaultPort)} inputMode="numeric" />
                </label>
                <label className="col-span-2 text-sm">
                  <span className="mb-1 block text-xs text-zinc-500">Host</span>
                  <input value={host} onChange={(e) => setHost(e.target.value)} className={inp} placeholder="10.0.0.5 ou db.interno" />
                </label>
              </div>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">Banco</span>
                <input value={database} onChange={(e) => setDatabase(e.target.value)} className={inp} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">Usuário (somente leitura, de preferência)</span>
                <input value={username} onChange={(e) => setUsername(e.target.value)} className={inp} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs text-zinc-500">
                  Senha {isEdit && (
                    <span className="text-zinc-400">
                      (em branco = {existing?.native && !existing?.managed ? 'usa a senha do .env' : 'mantém a atual'})
                    </span>
                  )}
                </span>
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className={inp} placeholder={isEdit ? '••••••••' : ''} autoComplete="new-password" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} />
                <span>Conexão SSL</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={writable} onChange={(e) => setWritable(e.target.checked)} className="mt-0.5" />
                <span>Permitir <strong>escrita</strong> (produtos de escrita)<br />
                  <span className="text-xs text-zinc-400">Use um usuário com permissão de INSERT. As fontes de produção devem ficar desmarcadas.</span>
                </span>
              </label>
            </>
          )}

          {testResult && (
            <p className={`flex items-center gap-1.5 text-sm ${testResult.ok ? 'text-emerald-600' : 'text-red-500'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {testResult.ok
                ? `Alcançou em ${testResult.latencyMs} ms${testResult.status ? ` (HTTP ${testResult.status})` : ''}`
                : `Falhou: ${testResult.error}`}
            </p>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="mt-1 flex justify-between gap-2">
            <button onClick={test} disabled={busy || !valid}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Testar
            </button>
            <button onClick={save} disabled={busy || !valid}
              className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-accent-hover disabled:opacity-50">
              {busy && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Salvar' : 'Criar conexão'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
