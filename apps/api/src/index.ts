// ─────────────────────────────────────────────────────────────────────────
// Data Hub API — entrada do backend. As rotas são montadas em app.ts (sem
// efeitos colaterais, para os testes de integração usarem o mesmo app); aqui
// fica o que só o servidor de verdade faz: migrations, limpeza do lake,
// caches de processo, agendador, embeddings e o listen.
// ─────────────────────────────────────────────────────────────────────────
import { config } from './core/config.js'
import { runMigrations, isDbAvailable } from './db/pool.js'
import { createApp } from './app.js'
import { reloadAiProviders } from './modules/ai/providerStore.js'
import { reloadUpstreams } from './modules/gateway/upstreams.js'
import { startScheduler, startHealthChecks } from './modules/sync/scheduler.js'
import { reindexEmbeddings } from './modules/ai/embeddings.js'
import { cleanStaging, faxinaLake } from './core/lake.js'
import { closeOrphanRuns } from './modules/sync/ingest.js'
import { reloadConnections, avisoDeConexoes } from './connectors/store.js'
import { reloadMasterAdmins } from './modules/auth/masterAdmins.js'
import { ensureApiMetricsDataset, ensureApiSummaryDerived, ensureApiMetricsDashboard, ensureApiRuntimeWidget } from './modules/catalog/apiMetricsDataset.js'

// Rede de segurança: Express 4 não encaminha rejeições de handlers async ao
// middleware de erro — sem isto, um único erro de SQL derruba a API inteira
// (foi o que aconteceu com o 42702 do POST /metrics). Logamos e seguimos vivos.
process.on('unhandledRejection', (err) => {
  console.error('[api] rejeição não tratada (rota async?):', err)
})
process.on('uncaughtException', (err) => {
  console.error('[api] exceção não capturada:', err)
})

const app = createApp()

// Quem pode mexer em como as FONTES atualizam. Anunciado no boot porque a
// lista vem do ambiente da stack, não do banco: sem isto, uma stack sem
// MASTER_ADMIN_EMAILS nem ADMIN_EMAILS trancaria a configuração das fontes
// para todo mundo — e o sintoma (403 em quem sempre pôde) não apontaria para a
// variável que faltou.
if (config.masterAdminEmails.length) {
  console.log(
    `[auth] admin master pelo ambiente: ${config.masterAdminEmails.join(', ')} ` +
    '(raiz de confiança; outros podem ser concedidos em Usuários e Acessos).',
  )
} else {
  console.warn(
    '[auth] NENHUM admin master no ambiente. Se também não houver nenhum concedido pela tela, ' +
    'ninguém poderá alterar a regra de atualização das FONTES — e não haverá caminho de ' +
    'recuperação. Defina MASTER_ADMIN_EMAILS (ou ADMIN_EMAILS) na stack.',
  )
}

await runMigrations()
// Remove JSONL de staging órfão de uma carga anterior morta na marra (evita
// acúmulo de dezenas de GB no volume do lake). No boot não há sync rodando.
try {
  const n = cleanStaging()
  if (n) console.log(`[lake] staging: ${n} arquivo(s) órfão(s) removido(s).`)
} catch (e) {
  console.warn(`[lake] limpeza de staging falhou: ${(e as Error).message}`)
}
// Parquet pela metade de uma escrita interrompida. Um único arquivo truncado
// derruba a leitura do conjunto INTEIRO — e de todo calculado e painel que o
// usam —, com uma mensagem que não diz nem qual conjunto. Aqui, no boot, nada
// está escrevendo, então é o momento seguro de varrer.
try {
  const f = faxinaLake()
  if (f.parciais.length) console.log(`[lake] ${f.parciais.length} parte(s) pela metade removida(s).`)
  for (const q of f.emQuarentena) {
    console.warn(`[lake] ARQUIVO CORROMPIDO posto em quarentena: ${q} -> ${q}.corrompido. ` +
      'O conjunto volta a ser legível; re-sincronize ou re-materialize para repor as linhas.')
  }
} catch (e) {
  console.warn(`[lake] faxina de parquet falhou: ${(e as Error).message}`)
}
// Carrega as conexões GERENCIADAS (cadastradas na tela) para o registry.
if (isDbAvailable()) {
  // Execuções penduradas em 'running' de um processo que morreu no meio. Sem
  // isto o conjunto fica "sincronizando" para sempre na tela e o botão de
  // sincronizar nunca reabilita.
  await closeOrphanRuns()
    .then((n) => { if (n) console.log(`[sync] ${n} execução(ões) órfã(s) fechada(s) no boot.`) })
    .catch((e) => console.warn(`[sync] falha ao fechar execuções órfãs: ${(e as Error).message}`))
  // Masters concedidos pela tela — a checagem é contra um Set em memória.
  await reloadMasterAdmins().catch((e) =>
    console.warn(`[auth] carga inicial de masters falhou: ${(e as Error).message}`))
  // A carga das conexões não pode mais ser silenciosa. Quando a chave falta ou
  // mudou, a plataforma perde TODAS as conexões cadastradas pela tela e, sem
  // isto, sobe saudável como se nada fosse — foi o que escondeu um incidente
  // por três dias. Não derruba o boot de propósito: as fontes do ambiente
  // (DB_*) seguem funcionando, e tirar a plataforma inteira do ar seria pior
  // que o problema.
  await reloadConnections()
    .then((r) => {
      const aviso = avisoDeConexoes(r)
      if (aviso) {
        console.error(`\n${'='.repeat(78)}\n[connections] ${aviso}\n${'='.repeat(78)}\n`)
      } else if (r.carregadas) {
        console.log(`[connections] ${r.carregadas} conexão(ões) cadastrada(s) carregada(s).`)
      }
    })
    .catch((e) => console.warn(`[connections] carga inicial falhou: ${(e as Error).message}`))
  // Registro de upstreams do gateway no cache de processo (o proxy não pode ir
  // ao banco a cada requisição).
  await reloadUpstreams().catch((e) =>
    console.warn(`[gateway] carga inicial de upstreams falhou: ${(e as Error).message}`))
  // Provedores de IA cadastrados na tela (a chave sai do .env).
  await reloadAiProviders().catch((e) =>
    console.warn(`[ai] carga inicial de provedores falhou: ${(e as Error).message}`))
  // Painel de saúde das APIs "de graça": provisiona o dataset de métricas.
  await ensureApiMetricsDataset().catch((e) =>
    console.warn(`[api-metrics] provisionamento falhou: ${(e as Error).message}`))
  await ensureApiSummaryDerived().catch((e) =>
    console.warn(`[api-metrics] derivado falhou: ${(e as Error).message}`))
  await ensureApiMetricsDashboard().catch((e) =>
    console.warn(`[api-metrics] dashboard falhou: ${(e as Error).message}`))
  await ensureApiRuntimeWidget().catch((e) =>
    console.warn(`[api-metrics] widget de latência no tempo falhou: ${(e as Error).message}`))
}
startScheduler() // sync diário na madrugada (ETL_HOUR)
startHealthChecks() // Fase 3: monitor de uptime a cada 60s
// Catálogo semântico: indexa em background os datasets sem embedding (ou com
// texto desatualizado). Não bloqueia o boot — na 1ª vez baixa o modelo (~120MB).
if (isDbAvailable()) {
  void reindexEmbeddings().catch((e) =>
    console.warn(`[embeddings] indexação inicial falhou: ${(e as Error).message}`))
}
app.listen(config.apiPort, () => {
  console.log(`[api] Data Hub API em http://localhost:${config.apiPort}`)
})
