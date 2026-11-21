// ─────────────────────────────────────────────────────────────────────────
// Sugestões de melhoria (item 2 de 19/11/2026): o módulo lê e grava no MESMO
// banco do Hub Apps. Aqui um DB_Hub_Apps de laboratório no MariaDB de teste,
// com as três tabelas como estão no servidor e uma sugestão de OUTRO app, que
// o Data Hub não pode ver nem alterar.
// Só roda onde há MariaDB de teste (job api-mariadb do CI); no job só com
// Postgres fica pulado.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { as, shutdown } from './harness.js'
import { fecharSugestoes } from '../modules/suggestions/store.js'

const host = process.env.DATAHUB_TEST_MARIA_HOST
const pular = !host ? 'sem MariaDB de teste (DATAHUB_TEST_MARIA_HOST)' : false
const BANCO = `hub_apps_teste_${process.pid}`
const APP = 'app-datahub-teste'
const cred = {
  host, port: Number(process.env.DATAHUB_TEST_MARIA_PORT || 3306),
  user: process.env.DATAHUB_TEST_MARIA_USER, password: process.env.DATAHUB_TEST_MARIA_PASSWORD,
}
let admin: mysql.Connection | null = null
let idOutroApp = 0

before(async () => {
  if (pular) return
  admin = await mysql.createConnection({ ...cred, multipleStatements: true })
  await admin.query(`create database ${BANCO} character set utf8mb4 collate utf8mb4_unicode_ci`)
  await admin.query(`use ${BANCO};
    create table platform_suggestions (
      id bigint unsigned not null auto_increment primary key, title varchar(191) not null, description text not null,
      sector varchar(120) not null, app_id varchar(64) null, category varchar(120) null, status varchar(24) not null default 'open',
      author_uid varchar(128) not null, author_email varchar(191) not null, author_name varchar(191) not null,
      author_photo_url varchar(1024) null, likes_count int not null default 0, dislikes_count int not null default 0,
      comments_count int not null default 0, score int not null default 0,
      created_at datetime not null default current_timestamp, updated_at datetime not null default current_timestamp on update current_timestamp);
    create table platform_suggestion_votes (
      id bigint unsigned not null auto_increment primary key, suggestion_id bigint unsigned not null, user_uid varchar(128) not null,
      user_email varchar(191) not null, user_name varchar(191) not null, user_photo_url varchar(1024) null, vote_type varchar(16) not null,
      created_at datetime not null default current_timestamp, updated_at datetime not null default current_timestamp on update current_timestamp,
      unique key uq_voto (suggestion_id, user_uid),
      foreign key (suggestion_id) references platform_suggestions(id) on delete cascade);
    create table platform_suggestion_comments (
      id bigint unsigned not null auto_increment primary key, suggestion_id bigint unsigned not null, author_uid varchar(128) not null,
      author_email varchar(191) not null, author_name varchar(191) not null, author_photo_url varchar(1024) null, message text not null,
      created_at datetime not null default current_timestamp, updated_at datetime not null default current_timestamp on update current_timestamp,
      foreign key (suggestion_id) references platform_suggestions(id) on delete cascade);
    insert into platform_suggestions (title, description, sector, app_id, author_uid, author_email, author_name, created_at)
      values ('Sugestão do Splitters', 'Esta é de outro sistema e não aparece aqui.', 'Rede', 'app-splitters-sebratel', 'u', 'x@sebratel.com.br', 'X', '2026-11-01 10:00:00'),
             ('Exportar para Excel', 'Poder baixar qualquer conjunto em Excel direto da tela.', 'Comercial', '${APP}', 'u', 'y@sebratel.com.br', 'Y', '2026-11-10 09:30:00')`)
  const [r] = await admin.query(`select id from ${BANCO}.platform_suggestions where app_id = 'app-splitters-sebratel'`)
  idOutroApp = Number((r as { id: number }[])[0].id)
  process.env.HUB_APPS_MYSQL_HOST = host
  process.env.HUB_APPS_MYSQL_PORT = String(cred.port)
  process.env.HUB_APPS_MYSQL_USER = cred.user
  process.env.HUB_APPS_MYSQL_PASSWORD = cred.password
  process.env.HUB_APPS_MYSQL_DATABASE = BANCO
})

after(async () => {
  await fecharSugestoes()
  if (admin) {
    await admin.query(`drop database if exists ${BANCO}`)
    await admin.end()
  }
  await shutdown()
})

describe('Sugestões de melhoria (banco do Hub Apps)', { skip: pular }, () => {
  it('sem o id do app, a tela recebe o que falta configurar (não é erro)', async () => {
    delete process.env.PLATFORM_SUGGESTIONS_APP_ID
    const r = await as('viewer').get('/api/v1/suggestions')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.suggestions, [])
    assert.deepEqual(r.body.meta.missing, ['PLATFORM_SUGGESTIONS_APP_ID'])
  })

  it('somente leitura (padrão): lista só o app do Data Hub e recusa escrita', async () => {
    process.env.PLATFORM_SUGGESTIONS_APP_ID = APP
    delete process.env.PLATFORM_SUGGESTIONS_READ_ONLY
    const r = await as('viewer').get('/api/v1/suggestions')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.suggestions.map((s: { title: string }) => s.title), ['Exportar para Excel'])
    assert.equal(r.body.meta.readOnly, true)
    assert.equal(r.body.suggestions[0].createdAt, '2026-11-10T09:30:00-03:00', 'DATETIME do Hub Apps é hora de Brasília')
    const w = await as('editor').post('/api/v1/suggestions', { title: 'Nova ideia', description: 'Uma descrição comprida o bastante.', sector: 'TI' })
    assert.equal(w.status, 403)
    assert.match(w.body.hubAppsUrl, /hub-apps/)
  })

  it('com escrita liberada: cria, vota (repetir desfaz), comenta e só admin muda status', async () => {
    process.env.PLATFORM_SUGGESTIONS_READ_ONLY = 'false'
    assert.equal((await as('editor').post('/api/v1/suggestions', { title: 'Oi', description: 'curta', sector: 'TI' })).status, 400)

    const c = await as('editor').post('/api/v1/suggestions', {
      title: 'Alerta quando a carga atrasar', description: 'Avisar no Chat quando um conjunto passar do horário.', sector: 'TI', category: 'Monitoramento',
    })
    assert.equal(c.status, 201, JSON.stringify(c.body))
    const id = c.body.suggestion.id
    assert.equal(c.body.suggestion.status, 'open')

    let v = await as('viewer').post(`/api/v1/suggestions/${id}/vote`, { voteType: 'like' })
    assert.deepEqual([v.body.suggestion.likesCount, v.body.suggestion.score, v.body.suggestion.viewerVote], [1, 1, 'like'])
    v = await as('viewer').post(`/api/v1/suggestions/${id}/vote`, { voteType: 'like' })
    assert.deepEqual([v.body.suggestion.likesCount, v.body.suggestion.viewerVote], [0, null], 'repetir o voto desfaz')
    v = await as('viewer').post(`/api/v1/suggestions/${id}/vote`, { voteType: 'dislike' })
    assert.deepEqual([v.body.suggestion.dislikesCount, v.body.suggestion.score], [1, -1])

    const m = await as('viewer').post(`/api/v1/suggestions/${id}/comments`, { message: 'Seria ótimo para a operação.' })
    assert.equal(m.status, 201)
    assert.equal(m.body.suggestion.commentsCount, 1)
    assert.equal(m.body.suggestion.comments[0].message, 'Seria ótimo para a operação.')

    assert.equal((await as('editor').patch(`/api/v1/suggestions/${id}/status`, { status: 'planned' })).status, 403)
    const s = await as('admin').patch(`/api/v1/suggestions/${id}/status`, { status: 'planned' })
    assert.equal(s.status, 200, JSON.stringify(s.body))
    assert.equal(s.body.suggestion.status, 'planned')
  })

  it('sugestão de outro app não pode ser votada nem ter status alterado daqui', async () => {
    assert.equal((await as('viewer').post(`/api/v1/suggestions/${idOutroApp}/vote`, { voteType: 'like' })).status, 404)
    assert.equal((await as('admin').patch(`/api/v1/suggestions/${idOutroApp}/status`, { status: 'done' })).status, 404)
  })
})
