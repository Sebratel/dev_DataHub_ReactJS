// Como conectar: o caminho de quem vai CONSUMIR, do zero à primeira linha.
// Exemplos genéricos — troque {SEU_DATASET} e {SEU_TOKEN} pelos valores reais.
//
// O token vai SÓ no cabeçalho X-Api-Token (SEG-06): na URL ele é recusado,
// porque ficava em log de acesso, histórico do navegador e Referer. Por isso o
// IMPORTDATA do Sheets não serve (não manda cabeçalho) e o exemplo é Apps Script.
import { useState } from 'react'
import { Link2, Copy, Check, KeyRound, Webhook, Plug } from 'lucide-react'
import { Card, CardHead } from '@/components/ui/Card'
import { ICON_BTN } from './shared'

export default function ConnectTab({ isAdmin, onGoTokens, onGoApis }: {
  isAdmin: boolean
  onGoTokens: () => void
  onGoApis: () => void
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const base = `${window.location.origin}/api/public/v1`
  const rowsUrl = `${base}/datasets/{SEU_DATASET}/rows`

  const examples = [
    {
      key: 'pbi', title: 'Power BI (Power Query)',
      hint: 'Obter Dados → Consulta em Branco → Editor Avançado. Em Fonte de dados, use o acesso Anônimo: quem autentica é o cabeçalho.',
      code: `Json.Document(Web.Contents("${rowsUrl}", [Headers = [#"X-Api-Token" = "{SEU_TOKEN}"], Query = [limit = "100000"]]))[rows]`,
    },
    {
      key: 'sheets', title: 'Google Sheets (Apps Script)',
      hint: 'Extensões → Apps Script, cole a função e rode. Para atualizar sozinho, crie um acionador por tempo. O IMPORTDATA não funciona: ele não envia cabeçalho.',
      code: [
        'function importarDataHub() {',
        `  const r = UrlFetchApp.fetch('${rowsUrl}?format=csv', {`,
        "    headers: { 'X-Api-Token': '{SEU_TOKEN}' },",
        '  });',
        '  const dados = Utilities.parseCsv(r.getContentText());',
        '  const aba = SpreadsheetApp.getActiveSheet();',
        '  aba.clearContents();',
        '  aba.getRange(1, 1, dados.length, dados[0].length).setValues(dados);',
        '}',
      ].join('\n'),
    },
    {
      key: 'excel', title: 'Excel',
      hint: 'Dados → Da Web → Avançado. Em "parâmetros de cabeçalho", adicione X-Api-Token com o token.',
      code: `${rowsUrl}?format=csv`,
    },
    {
      key: 'n8n', title: 'n8n',
      hint: 'Nó HTTP Request → Authentication: Generic Credential Type → Header Auth, com Name X-Api-Token e Value o token. Pagine com limit e offset.',
      code: `GET ${rowsUrl}?limit=1000&offset=0\nX-Api-Token: {SEU_TOKEN}`,
    },
    {
      key: 'rest', title: 'API REST (JSON paginado)',
      hint: 'Para scripts e sistemas. Aceita ?limit= e ?offset=; ?format=csv devolve CSV.',
      code: `curl -H "X-Api-Token: {SEU_TOKEN}" "${rowsUrl}?limit=1000&offset=0"`,
    },
  ]

  function copy(text: string, key: string) {
    void navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  const steps = [
    {
      icon: KeyRound, title: '1. Um token',
      text: isAdmin
        ? 'Gere na aba Tokens e marque o que ele lê, onde escreve e quais serviços alcança. Ele aparece uma vez só.'
        : 'Tokens são emitidos por um administrador. Peça um e diga quais conjuntos, APIs ou serviços o sistema precisa.',
      action: isAdmin ? { label: 'Ir para Tokens', go: onGoTokens } : null,
    },
    {
      icon: Webhook, title: '2. Um endereço',
      text: 'Um conjunto direto (/datasets/{slug}/rows), uma API pronta (/p/…, /w/…) ou um serviço interno (/gw/…). Cada API mostra o seu na aba APIs.',
      action: { label: 'Ver as APIs', go: onGoApis },
    },
    {
      icon: Plug, title: '3. O cabeçalho',
      text: 'Toda chamada leva X-Api-Token: {SEU_TOKEN}. Na URL (?token=) é recusado.',
      action: null,
    },
  ]

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid gap-2.5 md:grid-cols-3">
        {steps.map(({ icon: Icon, title, text, action }) => (
          <Card key={title} className="p-3">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold">
              <Icon size={13} strokeWidth={1.6} className="text-zinc-400" /> {title}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">{text}</p>
            {action && (
              <button onClick={action.go} className="mt-1.5 text-[11.5px] font-medium text-info hover:underline dark:text-info-dark">
                {action.label}
              </button>
            )}
          </Card>
        ))}
      </div>

      <Card>
        <CardHead icon={Link2} title="Exemplos" sub="troque {SEU_DATASET} e {SEU_TOKEN} pelos valores reais" />
        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {examples.map((ex) => (
            <div key={ex.key} className="grid items-start gap-2 p-3 lg:grid-cols-[280px_minmax(0,1fr)]">
              <div className="min-w-0">
                <p className="text-[12px] font-medium">{ex.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{ex.hint}</p>
              </div>
              <div className="flex min-w-0 items-start gap-1.5">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-zinc-50 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed dark:bg-zinc-950"><code>{ex.code}</code></pre>
                <button onClick={() => copy(ex.code, ex.key)} className={ICON_BTN} title="Copiar">
                  {copied === ex.key ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
