// Histórico de alertas, DENTRO do sistema.
//
// O canal principal é este: tudo que o Data Hub quis avisar (carga pausada,
// conciliação divergente, verificação falhando) fica aqui, com quem já viu. O
// sino do cabeçalho conta o que ninguém viu ainda. Mandar também para um chat
// é opcional e fica recolhido — nada sai do sistema se ninguém cadastrar.
import { useEffect, useState } from 'react'
import { Bell, BellOff, Send, CheckCheck, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import type { AlertSettingsView, AlertEventRow } from '@datahub/shared'
import { api } from '@/lib/api'
import { hoursSince, lagSince } from '@/lib/freshness'
import { useAuthStore } from '@/store/authStore'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill, type Tone } from '@/components/ui/Pill'

const ENTREGA: Record<AlertEventRow['status'], { label: string; tone: Tone } | null> = {
  // Sem chat cadastrado, o normal é ficar só aqui — não merece selo.
  'no-channel': null,
  sent: { label: 'também no chat', tone: 'ok' },
  failed: { label: 'chat falhou', tone: 'crit' },
}

export default function AlertsCard({ onSeen }: { onSeen?: () => void }) {
  const isMaster = useAuthStore((s) => !!s.user?.master)
  const [settings, setSettings] = useState<AlertSettingsView | null>(null)
  const [events, setEvents] = useState<AlertEventRow[]>([])
  const [chatAberto, setChatAberto] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  function load() {
    api<{ settings: AlertSettingsView; events: AlertEventRow[] }>('/api/v1/quality/alerts')
      .then((r) => { setSettings(r.settings); setEvents(r.events) })
      .catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : 'Falha ao carregar os alertas.' }))
  }
  useEffect(load, [])

  const naoVistos = events.filter((e) => !e.seenAt).length

  async function marcarVistos(ids?: string[]) {
    try {
      await api('/api/v1/quality/alerts/seen', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) })
      load()
      onSeen?.()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Não foi possível marcar como visto.' })
    }
  }

  async function salvar(body: { webhookUrl?: string; enabled?: boolean }, okText: string) {
    setBusy(true); setMsg(null)
    try {
      const r = await api<{ settings: AlertSettingsView }>('/api/v1/quality/alerts', { method: 'PUT', body: JSON.stringify(body) })
      setSettings(r.settings); setUrl('')
      setMsg({ ok: true, text: okText })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Não foi possível salvar.' })
    } finally { setBusy(false) }
  }

  async function testar() {
    setBusy(true); setMsg(null)
    try {
      await api('/api/v1/quality/alerts/test', { method: 'POST' })
      setMsg({ ok: true, text: 'Mensagem de teste enviada. Confira se chegou no espaço.' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'O teste falhou.' })
    } finally { setBusy(false); load() }
  }

  const inp = 'h-[30px] min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950'
  const btn = 'flex h-[28px] shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[11.5px] font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800'

  return (
    <Card>
      <CardHead icon={Bell} title="Alertas" sub={naoVistos ? `${naoVistos} não visto(s)` : 'nenhum alerta novo'}>
        {naoVistos > 0 && (
          <button className={btn} onClick={() => void marcarVistos()}>
            <CheckCheck size={12} strokeWidth={1.8} /> Marcar todos como vistos
          </button>
        )}
      </CardHead>

      {events.length === 0 ? (
        <p className="px-3 py-6 text-center text-[11.5px] text-zinc-400">Nenhum alerta até agora.</p>
      ) : (
        <ul className="max-h-[420px] divide-y divide-zinc-100 overflow-auto dark:divide-zinc-800">
          {events.slice(0, 50).map((e) => {
            const novo = !e.seenAt
            const entrega = ENTREGA[e.status]
            return (
              <li key={e.id} className={clsx('px-3 py-2', novo && 'bg-info-soft/40 dark:bg-info/5')}>
                <div className="flex items-center gap-1.5">
                  {novo && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info" aria-label="Não visto" />}
                  <span className={clsx('min-w-0 flex-1 truncate text-[11.5px]', novo ? 'font-semibold' : 'font-medium')}>{e.title}</span>
                  {entrega && <Pill tone={entrega.tone}>{entrega.label}</Pill>}
                  <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-400" title={new Date(e.createdAt).toLocaleString('pt-BR')}>
                    {lagSince(hoursSince(e.createdAt))}
                  </span>
                </div>
                <p className="mt-0.5 whitespace-pre-line text-[11px] text-zinc-500">{e.body}</p>
                {e.error && <p className="mt-0.5 text-[11px] text-crit dark:text-crit-dark">{e.error}</p>}
                <div className="mt-0.5 text-[10.5px] text-zinc-400">
                  {novo
                    ? <button className="text-info hover:underline dark:text-info-dark" onClick={() => void marcarVistos([e.id])}>Marcar como visto</button>
                    : <span>Visto por {e.seenBy} {lagSince(hoursSince(e.seenAt))}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Opcional: além da tela, mandar também para um chat. */}
      <div className="border-t border-zinc-200 dark:border-zinc-800">
        <button onClick={() => setChatAberto(!chatAberto)}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11.5px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          <ChevronRight size={13} className={clsx('transition-transform', chatAberto && 'rotate-90')} />
          Enviar também para um chat (opcional)
          {settings?.configured && (
            <Pill tone={settings.enabled ? 'ok' : 'neutral'} className="ml-1">{settings.enabled ? 'ligado' : 'desligado'}</Pill>
          )}
        </button>
        {chatAberto && (
          <div className="space-y-2 px-3 pb-3 text-[11.5px]">
            <p className="text-zinc-500">
              Os mesmos avisos podem ir para um webhook do Google Chat (ou qualquer endereço que receba{' '}
              <code>{'{"text": …}'}</code>, como um fluxo do n8n). O mesmo assunto não se repete em 12 h.
            </p>
            {settings?.configured && (
              <p className="text-zinc-600 dark:text-zinc-300">
                {settings.hint}
                {settings.lastTestAt && (
                  <span className="text-zinc-400"> · teste {settings.lastTestOk ? 'ok' : 'falhou'} {lagSince(hoursSince(settings.lastTestAt))}</span>
                )}
              </p>
            )}
            {isMaster ? (
              <>
                <div className="flex gap-1.5">
                  <input id="alert-webhook" value={url} onChange={(e) => setUrl(e.target.value)} className={inp}
                    placeholder={settings?.configured ? 'Novo endereço (deixe vazio para manter)' : 'https://chat.googleapis.com/v1/spaces/…'} />
                  <button className={btn} disabled={busy || !url.trim()}
                    onClick={() => void salvar({ webhookUrl: url.trim() }, 'Webhook salvo. Use "Testar" para conferir.')}>
                    Salvar
                  </button>
                </div>
                {settings?.configured && (
                  <div className="flex flex-wrap gap-1.5">
                    <button className={btn} disabled={busy} onClick={() => void testar()}>
                      <Send size={12} strokeWidth={1.8} /> Testar
                    </button>
                    <button className={btn} disabled={busy}
                      onClick={() => void salvar({ enabled: !settings.enabled }, settings.enabled ? 'Envio ao chat desligado.' : 'Envio ao chat ligado.')}>
                      {settings.enabled ? <BellOff size={12} strokeWidth={1.8} /> : <Bell size={12} strokeWidth={1.8} />}
                      {settings.enabled ? 'Desligar' : 'Ligar'}
                    </button>
                    <button className={clsx(btn, 'text-crit dark:text-crit-dark')} disabled={busy}
                      onClick={() => void salvar({ webhookUrl: '' }, 'Webhook removido.')}>
                      Remover
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="text-zinc-400">Só o admin master cadastra o chat.</p>
            )}
            {msg && <p className={msg.ok ? 'text-ok dark:text-ok-dark' : 'text-crit dark:text-crit-dark'}>{msg.text}</p>}
          </div>
        )}
      </div>
    </Card>
  )
}
