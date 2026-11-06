// Visão geral: o que está no ar, o que espera decisão e quem está chamando.
// A fila de aprovação é UMA só — antes a escrita pendente ficava na tela APIs
// e o serviço pendente na tela Gateway, e o admin precisava lembrar das duas.
import { Activity, Gauge, ShieldCheck, Webhook, Check, X, Users, Clock } from 'lucide-react'
import KpiBar, { type Kpi } from '@/components/ui/KpiBar'
import { Card, CardHead } from '@/components/ui/Card'
import { DataGrid, Th, Tr, Td } from '@/components/ui/DataGrid'
import { MethodChip, isExpired, type Credential } from './shared'
import { KIND, isLive, type CatalogItem } from './ApisTab'
import { UsageCell, TokenPill } from './TokensTab'

const DIA = 86_400_000

export default function OverviewTab({ items, credentials, calls, isAdmin, me, onReview, onEditToken, onGoTokens, onGoApis }: {
  items: CatalogItem[]
  credentials: Credential[]
  calls: Map<string, number>
  isAdmin: boolean
  me: string
  onReview: (it: CatalogItem, approve: boolean) => void
  onEditToken: (c: Credential) => void
  onGoTokens: () => void
  onGoApis: () => void
}) {
  const live = items.filter(isLive)
  const pending = items.filter((i) => i.status === 'pending')
  const myPending = pending.filter((i) => i.owner === me)
  const activeTokens = credentials.filter((c) => !c.revoked && !isExpired(c))
  const callsToday = activeTokens.reduce((s, c) => s + (calls.get(c.id) ?? 0), 0)
  const usedToday = activeTokens.filter((c) => (calls.get(c.id) ?? 0) > 0).length
  const unlimited = activeTokens.filter((c) => !c.rate_limit_per_min && !c.quota_per_day).length
  const expiring = activeTokens.filter((c) => c.expires_at && new Date(c.expires_at).getTime() - Date.now() < 15 * DIA).length

  const byKind = (k: CatalogItem['kind']) => live.filter((i) => i.kind === k).length
  const kpis: Kpi[] = [
    {
      label: 'APIs no ar', icon: Webhook, value: String(live.length),
      foot: `${byKind('read')} leitura · ${byKind('write')} escrita · ${byKind('service')} serviço(s)`,
    },
    {
      label: 'Aguardando aprovação', icon: ShieldCheck, value: String(pending.length),
      foot: pending.length ? 'não respondem ainda' : 'nada na fila',
    },
    // Consumo e tokens são assunto de admin (D-SEG-3): só chegam para ele.
    ...(isAdmin ? [
      { label: 'Chamadas hoje', icon: Activity, value: callsToday.toLocaleString('pt-BR'), foot: `${usedToday} token(s) chamaram hoje` },
      {
        label: 'Tokens ativos', icon: Gauge, value: String(activeTokens.length),
        foot: [unlimited ? `${unlimited} sem limite` : 'todos com limite', expiring ? `${expiring} vence(m) em 15 dias` : '']
          .filter(Boolean).join(' · '),
      },
    ] : []),
  ]

  // Quem mais chamou hoje primeiro; os parados não somem (a pergunta "quem
  // está usando?" também se responde por quem NÃO está).
  const consumers = [...activeTokens].sort((a, b) => (calls.get(b.id) ?? 0) - (calls.get(a.id) ?? 0)).slice(0, 8)

  const queue = isAdmin ? pending : myPending

  return (
    <div className="flex flex-col gap-2.5">
      <KpiBar items={kpis} />

      {queue.length > 0 && (
        <Card className="border-warn/40">
          <CardHead icon={isAdmin ? ShieldCheck : Clock}
            title={isAdmin ? 'Aguardando sua aprovação' : 'Suas APIs aguardando um administrador'}
            sub={`${queue.length}`} />
          <div className="flex flex-col">
            {queue.map((it) => {
              const Icon = KIND[it.kind].icon
              return (
                <div key={it.key} className="flex items-center gap-3 border-b border-zinc-200 px-3 py-2 last:border-b-0 dark:border-zinc-800">
                  <Icon size={14} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium">
                      {it.name} <span className="font-normal text-zinc-400">· {KIND[it.kind].label}</span>
                    </p>
                    <p className="truncate font-mono text-[10.5px] text-zinc-500">{it.path} → {it.target}</p>
                  </div>
                  <span className="hidden shrink-0 items-center gap-1 sm:flex">
                    {it.methods.map((m) => <MethodChip key={m} m={m} />)}
                  </span>
                  <span className="hidden shrink-0 text-[10.5px] text-zinc-400 md:inline">{it.owner}</span>
                  {isAdmin && (
                    <>
                      <button onClick={() => onReview(it, true)}
                        className="flex shrink-0 items-center gap-1 rounded-lg bg-ok px-2.5 py-1 text-[11px] font-semibold text-white transition-opacity hover:opacity-90">
                        <Check size={12} strokeWidth={2.4} /> Aprovar
                      </button>
                      <button onClick={() => onReview(it, false)}
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:border-crit hover:text-crit dark:border-zinc-700 dark:text-zinc-300">
                        <X size={12} strokeWidth={2.4} /> Recusar
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {isAdmin ? (
        <Card>
          <CardHead icon={Users} title="Consumo de hoje" sub="por token">
            <button onClick={onGoTokens} className="text-[11px] font-medium text-info hover:underline dark:text-info-dark">
              Ver todos os tokens
            </button>
          </CardHead>
          {consumers.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-zinc-500">Nenhum token ativo.</p>
          ) : (
            <DataGrid fixed>
              <thead>
                <tr>
                  <Th>Token</Th>
                  <Th className="w-[190px]">Chamadas hoje</Th>
                  <Th right className="w-[112px]">Limite / min</Th>
                  <Th className="w-[120px]">Situação</Th>
                </tr>
              </thead>
              <tbody>
                {consumers.map((c) => (
                  <Tr key={c.id} onClick={() => onEditToken(c)}>
                    <Td><span className="block truncate text-[12px] font-medium">{c.name}</span></Td>
                    <Td><UsageCell calls={calls.get(c.id) ?? 0} quota={c.quota_per_day} /></Td>
                    <Td right muted>{c.rate_limit_per_min ? `${c.rate_limit_per_min}/min` : '—'}</Td>
                    <Td><TokenPill c={c} calls={calls.get(c.id) ?? 0} /></Td>
                  </Tr>
                ))}
              </tbody>
            </DataGrid>
          )}
        </Card>
      ) : (
        <Card className="p-3">
          <p className="text-[12px] font-semibold">Para consumir uma API</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">
            Você cria e mantém APIs; quem chama precisa de um token, e tokens são emitidos por um administrador.
            Peça um e diga quais conjuntos, APIs ou serviços o sistema precisa.{' '}
            <button onClick={onGoApis} className="font-medium text-info hover:underline dark:text-info-dark">Ver as APIs</button>
          </p>
        </Card>
      )}
    </div>
  )
}
