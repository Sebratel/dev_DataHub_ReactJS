// Menu "Painéis": o dashia embutido, ocupando a área inteira de conteúdo (o
// AppShell tira a margem nesta rota).
//
// Entrada: a cada montagem (abrir o menu, recarregar o quadro) o Data Hub pede
// à API um token de 5 min, de uso único, e abre o dashia com ?sso_token=. O
// token diz de onde veio a sessão daqui (Hub ou login direto); com HUB_ONLY
// ligado lá, só a do Hub entra. Sem o token (segredo não configurado ou falha),
// o quadro abre o dashia como antes e o login acontece dentro dele.
//
// Os painéis próprios do Data Hub saíram do menu, mas continuam em /dashboards
// para quem tem o link (Início, conjuntos, Saúde das APIs).
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { DASHIA_URL } from './dashia'

function comToken(url: string, token: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}sso_token=${encodeURIComponent(token)}`
}

export default function DashiaPage() {
  const [src, setSrc] = useState<string | null>(null)
  const [carregou, setCarregou] = useState(false)

  useEffect(() => {
    let vivo = true
    api<{ token: string }>('/api/v1/dashia/sso-token', { method: 'POST' })
      .then((r) => { if (vivo) setSrc(comToken(DASHIA_URL, r.token)) })
      .catch(() => { if (vivo) setSrc(DASHIA_URL) })
    return () => { vivo = false }
  }, [])

  return (
    <div className="relative h-full w-full bg-white dark:bg-zinc-950">
      {!carregou && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-zinc-500">
          Carregando os painéis…
        </div>
      )}
      {src && (
        <iframe
          src={src}
          title="Painéis (Indicadores Sebratel)"
          className="h-full w-full border-0"
          onLoad={() => setCarregou(true)}
          allow="clipboard-write; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      )}
    </div>
  )
}
