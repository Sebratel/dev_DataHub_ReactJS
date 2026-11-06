// Tokens — só admin (D-SEG-3). Uma linha por token com o que ele alcança,
// quanto já chamou hoje, os limites e a validade: o que antes se lia em duas
// telas (Integrações e Consumidores do Gateway) para responder "esse token
// está saudável?".
//
// Revogar ≠ excluir:
//   revogar  para de funcionar, fica na lista, preserva o histórico de uso;
//   excluir  some de vez, para o token criado por engano ou a integração morta.
import { KeyRound, Pencil, Ban, RotateCcw, Trash2, Loader2 } from 'lucide-react'
import { Card, CardHead } from '@/components/ui/Card'
import { Pill } from '@/components/ui/Pill'
import { EmptyState } from '@/components/ui/Page'
import { DataGrid, Th, Tr, Td, EntityCell, MiniBar } from '@/components/ui/DataGrid'
import { ICON_BTN, ICON_BTN_DANGER, fmtDate, isExpired, type Credential } from './shared'

export function scopeText(c: Credential) {
  return c.dataset_slugs.length ? c.dataset_slugs.join(', ') : 'todos os conjuntos'
}

export function UsageCell({ calls, quota }: { calls: number; quota: number | null }) {
  if (!quota) return <span className="text-[11.5px] tabular-nums text-zinc-500">{calls.toLocaleString('pt-BR')}</span>
  return (
    <span className="flex items-center gap-2">
      <MiniBar pct={(calls / quota) * 100} />
      <span className="text-[11px] tabular-nums text-zinc-500">
        {calls.toLocaleString('pt-BR')} / {quota.toLocaleString('pt-BR')}
      </span>
    </span>
  )
}

/** Situação do token: vida (revogado/expirado) antes de consumo. */
export function TokenPill({ c, calls }: { c: Credential; calls: number }) {
  if (c.revoked) return <Pill>revogado</Pill>
  if (isExpired(c)) return <Pill tone="warn">expirado</Pill>
  const pct = c.quota_per_day ? (calls / c.quota_per_day) * 100 : 0
  if (c.quota_per_day && pct >= 100) return <Pill tone="crit">cota esgotada</Pill>
  if (c.quota_per_day && pct >= 80) return <Pill tone="warn">{Math.round(pct)}% da cota</Pill>
  if (!c.quota_per_day && !c.rate_limit_per_min) return <Pill tone="warn">sem limite</Pill>
  return <Pill tone="ok">ativo</Pill>
}

export default function TokensTab({ credentials, calls, me, busyId, onNew, onEdit, onRevoke, onDelete }: {
  credentials: Credential[] | null
  calls: Map<string, number>
  me: string
  busyId: string | null
  onNew: () => void
  onEdit: (c: Credential) => void
  onRevoke: (c: Credential, revoked: boolean) => void
  onDelete: (c: Credential) => void
}) {
  return (
    <Card>
      <CardHead icon={KeyRound} title="Tokens" sub={credentials ? String(credentials.length) : undefined}>
        <span className="text-[10.5px] text-zinc-400">clique para editar escopo e limites</span>
      </CardHead>
      {credentials === null ? (
        <p className="px-3 py-8 text-center text-[12px] text-zinc-500">Carregando…</p>
      ) : credentials.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          message="Nenhum token ainda. Gere o primeiro para um Power BI, uma planilha ou um sistema consumir os dados."
          action={(
            <button onClick={onNew} className="text-[12px] font-medium text-info hover:underline dark:text-info-dark">
              Criar o primeiro
            </button>
          )}
        />
      ) : (
        <DataGrid fixed>
          <thead>
            <tr>
              <Th className="w-[19%]">Token</Th>
              <Th>Alcance</Th>
              <Th className="w-[150px]">Chamadas hoje</Th>
              <Th className="w-[130px]">Limites</Th>
              <Th className="w-[92px]">Último uso</Th>
              <Th className="w-[92px]">Validade</Th>
              <Th className="w-[112px]">Situação</Th>
              <Th className="w-[84px]"><span className="sr-only">Ações</span></Th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((c) => {
              const n = calls.get(c.id) ?? 0
              const busy = busyId === c.id
              const dead = c.revoked || isExpired(c)
              const escopo = scopeText(c)
              const extra = [
                c.write_slugs?.length ? `escrita: ${c.write_slugs.join(', ')}` : '',
                c.upstream_slugs?.length ? `serviços: ${c.upstream_slugs.join(', ')}` : '',
              ].filter(Boolean).join(' · ')
              const limites = [
                c.rate_limit_per_min ? `${c.rate_limit_per_min}/min` : '',
                c.quota_per_day ? `${c.quota_per_day.toLocaleString('pt-BR')}/dia` : '',
              ].filter(Boolean).join(' · ')
              return (
                <Tr key={c.id} onClick={() => onEdit(c)}>
                  <Td>
                    <EntityCell name={c.name} slug={c.owner_email === me ? 'você' : c.owner_email}>
                      <KeyRound size={13} strokeWidth={1.5}
                        className={dead ? 'shrink-0 text-zinc-300 dark:text-zinc-600' : 'shrink-0 text-accent'} />
                    </EntityCell>
                  </Td>
                  <Td>
                    <span className="block truncate text-[11.5px]" title={escopo}>{escopo}</span>
                    {extra && <span className="block truncate text-[10px] text-zinc-500" title={extra}>{extra}</span>}
                  </Td>
                  <Td>{dead ? <span className="text-[11px] text-zinc-400">—</span> : <UsageCell calls={n} quota={c.quota_per_day} />}</Td>
                  <Td muted>{limites || <span className="text-zinc-400">nenhum</span>}</Td>
                  <Td muted>{c.last_used_at ? fmtDate(c.last_used_at) : 'nunca'}</Td>
                  <Td muted>{c.expires_at ? fmtDate(c.expires_at) : '—'}</Td>
                  <Td><TokenPill c={c} calls={n} /></Td>
                  <Td onClick={(e) => e.stopPropagation()}>
                    <span className="flex items-center justify-end gap-0.5">
                      {busy && <Loader2 size={12} className="animate-spin text-zinc-400" />}
                      <button onClick={() => onEdit(c)} className={ICON_BTN} title="Editar escopo, limites e validade">
                        <Pencil size={13} strokeWidth={1.6} />
                      </button>
                      <button onClick={() => onRevoke(c, !c.revoked)} disabled={busy} className={ICON_BTN}
                        title={c.revoked ? 'Reativar token' : 'Revogar — para de funcionar, mas fica no histórico'}>
                        {c.revoked ? <RotateCcw size={13} strokeWidth={1.6} /> : <Ban size={13} strokeWidth={1.6} />}
                      </button>
                      <button onClick={() => onDelete(c)} disabled={busy} title="Excluir definitivamente" className={ICON_BTN_DANGER}>
                        <Trash2 size={13} strokeWidth={1.6} />
                      </button>
                    </span>
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </DataGrid>
      )}
    </Card>
  )
}
