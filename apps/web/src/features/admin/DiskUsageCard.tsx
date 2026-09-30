// Uso de disco do volume do lake.
//
// O gráfico do servidor mostrava um "dente de serra" chegando a 93%, e a única
// forma de investigar era correlacionar o Grafana com o log de auditoria na mão
// — depois que o pico já tinha passado. Aqui a resposta fica ao lado do botão
// que causa o pico.
//
// Em repouso o card é discreto: uma linha. Acima do teto ele muda de cor e
// explica — porque nesse momento a informação deixa de ser curiosidade e passa
// a ser decisão ("enfileiro mais vinte recargas agora ou não?").
import { useEffect, useState } from 'react'
import { HardDrive, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { Card } from '@/components/ui/Card'

interface Uso {
  totalBytes: number
  freeBytes: number
  usedPercent: number
  lakeBytes: number
  stagingBytes: number
  biggest: { tenant: string; slug: string; bytes: number }[]
  warnPercent: number
  alert: string | null
}

const gb = (n: number) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

export default function DiskUsageCard() {
  const [uso, setUso] = useState<Uso | null>(null)
  const [aberto, setAberto] = useState(false)

  useEffect(() => {
    let vivo = true
    const carregar = () => {
      api<Uso>('/api/v1/disk')
        .then((r) => { if (vivo) setUso(r) })
        .catch(() => { /* acessório: nunca atrapalha a tela */ })
    }
    carregar()
    // 30s: o disco não muda de segundo em segundo, e durante uma carga longa
    // este card fica aberto por horas.
    const t = setInterval(carregar, 30_000)
    return () => { vivo = false; clearInterval(t) }
  }, [])

  if (!uso) return null
  const alerta = !!uso.alert

  return (
    <Card className={`mb-2.5 ${alerta ? 'border-warn/50' : ''}`}>
      <button
        onClick={() => setAberto((v) => !v)}
        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${alerta ? 'bg-warn-soft dark:bg-warn/10' : ''}`}
      >
        {alerta
          ? <AlertTriangle size={14} className="shrink-0 text-warn dark:text-warn-dark" />
          : <HardDrive size={14} className="shrink-0 text-zinc-400" />}
        <span className={`text-[12px] font-medium ${alerta ? 'text-warn dark:text-warn-dark' : ''}`}>
          Disco do lake: {uso.usedPercent}%
        </span>
        <span className="text-[11px] text-zinc-500">
          {gb(uso.freeBytes)} livres de {gb(uso.totalBytes)}
          {uso.stagingBytes > 0 && ` · ${gb(uso.stagingBytes)} em carga`}
        </span>
        <span className="ml-auto text-[10.5px] text-zinc-400">{aberto ? 'fechar' : 'detalhar'}</span>
      </button>

      {alerta && (
        <p className="border-t border-warn/30 px-3 py-2 text-[11.5px] leading-relaxed text-warn dark:text-warn-dark">
          {uso.alert}
        </p>
      )}

      {aberto && (
        <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <p className="mb-1.5 text-[11px] text-zinc-500">
            Dados no lake: <strong>{gb(uso.lakeBytes)}</strong>. O restante do disco é do sistema,
            do banco de metadados e do que estiver em carga.
          </p>
          <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400">
            Maiores conjuntos
          </p>
          <div className="space-y-0.5">
            {uso.biggest.map((b) => (
              <div key={`${b.tenant}/${b.slug}`} className="flex items-center gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300">{b.slug}</span>
                <span className="shrink-0 tabular-nums text-zinc-400">{gb(b.bytes)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}
