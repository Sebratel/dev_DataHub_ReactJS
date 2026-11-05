// Sino do cabeçalho (só admin): o aviso DENTRO do sistema.
//
// Mostra quantos problemas estão abertos agora (vermelho se algum é crítico) e
// um ponto azul quando há alerta que ninguém do time viu. Leva para Saúde da
// plataforma. Consulta a cada minuto uma rota leve — só contagens.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import clsx from 'clsx'
import type { PlatformBadge } from '@datahub/shared'
import { api } from '@/lib/api'

// Quem marca alertas como vistos (a tela de saúde) pede para o sino reler na
// hora, em vez de esperar o próximo minuto.
const ouvintes = new Set<() => void>()
export function refreshAlertsBell(): void {
  ouvintes.forEach((f) => f())
}

export default function AlertsBell() {
  const navigate = useNavigate()
  const [b, setB] = useState<PlatformBadge | null>(null)

  useEffect(() => {
    let vivo = true
    const load = () => {
      api<PlatformBadge>('/api/v1/platform/badge')
        .then((r) => { if (vivo) setB(r) })
        .catch(() => { /* sino é acessório: falha de rede não vira erro na tela */ })
    }
    load()
    const t = setInterval(load, 60_000)
    ouvintes.add(load)
    return () => { vivo = false; clearInterval(t); ouvintes.delete(load) }
  }, [])

  const n = b?.problems ?? 0
  const titulo = !b ? 'Saúde da plataforma'
    : `${n ? `${n} problema(s) precisando de atenção${b.crit ? `, ${b.crit} crítico(s)` : ''}` : 'Nada precisando de atenção'}` +
      `${b.unseenAlerts ? ` · ${b.unseenAlerts} alerta(s) não visto(s)` : ''}`

  return (
    <button
      onClick={() => navigate('/admin/health')}
      title={titulo}
      aria-label={titulo}
      className="relative flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      <Bell size={15} strokeWidth={1.5} />
      {n > 0 && (
        <span className={clsx(
          'absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] font-bold tabular-nums text-white',
          b?.crit ? 'bg-crit' : 'bg-warn',
        )}>
          {n > 99 ? '99+' : n}
        </span>
      )}
      {n === 0 && !!b?.unseenAlerts && (
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-info" />
      )}
    </button>
  )
}
