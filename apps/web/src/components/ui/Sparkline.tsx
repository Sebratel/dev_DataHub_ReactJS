// Sparkline: tendência em miniatura para a barra de métricas-chave.
// Regras do design system: traço 1,5px, área com gradiente de 20%→0, e o
// PONTO FINAL destacado com anel da superfície — é o valor que o olho procura.
// A cor NÃO codifica o estado: quem carrega bom/ruim é o chip de delta ao lado.
import { useId } from 'react'

export type SparkTone = 'neutral' | 'good' | 'bad'

const STROKE: Record<SparkTone, string> = {
  neutral: 'var(--series-1)',
  good: 'var(--ok)',
  bad: 'var(--crit)',
}

interface Props {
  values: number[]
  tone?: SparkTone
  width?: number
  height?: number
  className?: string
}

export default function Sparkline({
  values, tone = 'neutral', width = 64, height = 22, className,
}: Props) {
  const gradId = useId()
  if (values.length < 2) return <div style={{ width, height }} className={className} />

  const stroke = STROKE[tone]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pad = 2.5
  const x = (i: number) => (i / (values.length - 1)) * width
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2)

  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const lastX = x(values.length - 1)
  const lastY = y(values[values.length - 1])

  return (
    <svg width={width} height={height} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.2} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${points} ${width},${height}`} fill={`url(#${gradId})`} />
      <polyline
        points={points} fill="none" stroke={stroke}
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"
      />
      <circle
        cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r={2.4}
        fill={stroke} stroke="var(--surface)" strokeWidth={1.6}
      />
    </svg>
  )
}
