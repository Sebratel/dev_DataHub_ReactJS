// Admin › Usuários e Acessos › Admin master.
//
// Por que este acesso não é um papel no seletor da aba "Usuários": aquele
// seletor é operado por QUALQUER admin, e qualquer admin pode se conceder
// 'admin' por ele. Um "master" ali seria auto-concedível — a trava das fontes
// não travaria nada. Aqui, só quem já é master concede.
//
// A aba mostra as DUAS origens porque elas se comportam de forma diferente, e
// esconder isso geraria a pergunta "por que este não tem botão de remover?":
//   • ambiente (MASTER_ADMIN_EMAILS) — raiz de confiança, fixa, caminho de
//     recuperação se a lista do banco for parar errada;
//   • concedido — delegação, removível aqui mesmo.
import { useEffect, useState } from 'react'
import { ShieldCheck, Plus, Trash2, Loader2, Lock } from 'lucide-react'
import type { MasterAdmin } from '@datahub/shared'
import { api } from '@/lib/api'
import { useConfirm } from '@/components/Dialogs'
import { useAuthStore } from '@/store/authStore'

export default function MastersTab() {
  const confirm = useConfirm()
  const me = useAuthStore((s) => s.user)
  const [masters, setMasters] = useState<MasterAdmin[] | null>(null)
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function load() {
    api<{ masters: MasterAdmin[] }>('/api/v1/admin/masters')
      .then((r) => setMasters(r.masters))
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar.'))
  }
  useEffect(load, [])

  async function grant() {
    if (!email.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api('/api/v1/admin/masters', {
        method: 'POST', body: JSON.stringify({ email: email.trim(), note: note.trim() }),
      })
      setEmail('')
      setNote('')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao conceder.')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(m: MasterAdmin) {
    const ok = await confirm({
      title: 'Remover acesso master',
      message:
        `${m.email} deixa de poder alterar como as FONTES atualizam — modo, chaves, identidade da ` +
        'linha, cadência e agendamento.\n\nO papel de administrador continua como está: ' +
        'só este acesso é retirado. Vale na hora, mesmo com a sessão da pessoa aberta.',
      danger: true,
      confirmLabel: 'Remover',
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/admin/masters/${encodeURIComponent(m.email)}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao remover.')
    } finally {
      setBusy(false)
    }
  }

  if (error && !masters) {
    return <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40">{error}</p>
  }
  if (!masters) return <p className="text-sm text-zinc-500">Carregando…</p>

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3.5 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm leading-relaxed text-zinc-500">
          O <strong>administrador master</strong> é o único que altera como as <strong>fontes</strong> atualizam —
          modo, chaves incrementais, identidade da linha, cadência e agendamento. Conjuntos calculados seguem
          liberados para administradores e editores, e disparar ou cancelar uma carga também.
          <br />
          Só um master concede este acesso a outra pessoa.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">E-mail</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void grant() }}
            placeholder="nome@sebratel.com.br"
            className="w-[280px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Motivo <span className="text-zinc-400">(opcional)</span></span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void grant() }}
            placeholder="ex.: responsável pela ingestão"
            className="w-[280px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <button
          onClick={() => void grant()}
          disabled={busy || !email.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-zinc-950 hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Conceder
        </button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2.5 font-medium">E-mail</th>
              <th className="px-4 py-2.5 font-medium">Origem</th>
              <th className="px-4 py-2.5 font-medium">Concedido por</th>
              <th className="px-4 py-2.5 text-right font-medium" />
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-zinc-950">
            {masters.map((m) => (
              <tr key={m.email} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2.5">
                  <span className="font-medium">{m.email}</span>
                  {m.email === me?.email && <span className="ml-2 text-xs text-zinc-400">(você)</span>}
                  {m.note && <p className="text-xs text-zinc-500">{m.note}</p>}
                </td>
                <td className="px-4 py-2.5">
                  {m.origin === 'env' ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                      <Lock size={12} /> Ambiente do servidor
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                      <ShieldCheck size={12} /> Concedido na tela
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">
                  {m.grantedBy ?? '—'}
                  {m.createdAt && <> · {new Date(m.createdAt).toLocaleDateString('pt-BR')}</>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {m.origin === 'env' ? (
                    // Sem botão, e com o motivo à vista: este é o caminho de
                    // recuperação. Um botão desabilitado sem explicação só
                    // geraria a pergunta.
                    <span className="text-xs text-zinc-400" title="Altere MASTER_ADMIN_EMAILS na stack e faça o redeploy.">
                      fixo na stack
                    </span>
                  ) : (
                    <button
                      onClick={() => void revoke(m)}
                      disabled={busy || m.email === me?.email}
                      title={m.email === me?.email
                        ? 'Você não pode remover o seu próprio acesso — peça a outro master.'
                        : 'Remover acesso master'}
                      className="rounded-md p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-red-950/40"
                    >
                      <Trash2 size={14} strokeWidth={1.6} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
