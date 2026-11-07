// Sino do cabeçalho (só admin): o aviso DENTRO do sistema.
//
// O NÚMERO é de alertas que ninguém do time viu — é o que "Marcar todos como
// vistos" zera. Antes ele contava os problemas abertos, que só somem quando a
// causa é resolvida: a pessoa marcava tudo como lido e o "4" continuava lá,
// parecendo defeito. Problema aberto sem alerta novo vira só um PONTO (vermelho
// se algum é crítico): continua visível, mas não pede para ser "lido".
// Leva para Saúde da plataforma. Consulta a cada minuto uma rota leve.
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

  const n = b?.unseenAlerts ?? 0
  const abertos = b?.problems ?? 0
  const titulo = !b ? 'Saúde da plataforma'
    : `${n ? `${n} alerta(s) não visto(s)` : 'Nenhum alerta novo'}` +
      ` · ${abertos ? `${abertos} problema(s) aberto(s)${b.crit ? `, ${b.crit} crítico(s)` : ''}` : 'nada precisando de atenção'}`

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
      {n === 0 && abertos > 0 && (
        <span className={clsx('absolute right-1 top-1 h-1.5 w-1.5 rounded-full', b?.crit ? 'bg-crit' : 'bg-warn')} />
      )}
    </button>
  )
}
