// Menu "Painéis": o dashia embutido, ocupando a área inteira de conteúdo (o
// AppShell tira a margem nesta rota). O login acontece dentro do quadro: o
// dashia entra por popup do Google e a sessão dele é um cookie SameSite=Lax,
// que vale aqui porque os dois endereços são do mesmo site (sebratel.net.br).
//
// Os painéis próprios do Data Hub saíram do menu, mas continuam em /dashboards
// para quem tem o link (Início, conjuntos, Saúde das APIs).
import { useState } from 'react'
import { DASHIA_URL } from './dashia'

export default function DashiaPage() {
  const [carregou, setCarregou] = useState(false)
  return (
    <div className="relative h-full w-full bg-white dark:bg-zinc-950">
      {!carregou && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-zinc-500">
          Carregando os painéis…
        </div>
      )}
      <iframe
        src={DASHIA_URL}
        title="Painéis (Indicadores Sebratel)"
        className="h-full w-full border-0"
        onLoad={() => setCarregou(true)}
        allow="clipboard-write; fullscreen"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  )
}
