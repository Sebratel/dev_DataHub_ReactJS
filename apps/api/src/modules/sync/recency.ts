// Qual versão da linha é a MAIS RECENTE — a regra que decide o upsert.
//
// Mora num módulo sem dependências de propósito: ela é usada pela compactação
// do lake (ingest) e pela consolidação do envio ao Databricks, e precisa ser a
// MESMA nos dois. Deixá-la dentro do ingest obrigava quem envia a importar o
// motor de ingestão inteiro, e isso fechava um ciclo de imports.
//
// Duas cópias desta regra divergiriam com o tempo, e a divergência apareceria
// do pior jeito possível: o painel do Databricks mostrando uma versão da linha
// diferente da que o Data Hub mostra, sem erro em lugar nenhum.

// Uma chave incremental identifica a linha; NEM TODA identifica um INSTANTE.
// Quando a tabela de origem não tem coluna de criação, o hub usa o `id`
// numérico como 1ª chave ("linha nova = id maior"). Juntar esse `id` com a 2ª
// chave num `greatest(id, updated_at)` é comparar número com data: o DuckDB
// recusa a consulta inteira ("Cannot combine types of DOUBLE and TIMESTAMP") e
// a compactação — logo, a sincronização — falha em toda execução.
//
// E, mesmo que o banco aceitasse, não faria sentido: `id` não é um instante,
// então ordenar por "o maior entre um id e uma data" não diz qual versão da
// linha é a mais recente.
//
// Regra: quem decide recência são as chaves TEMPORAIS. Havendo alguma, só elas
// entram. Não havendo nenhuma (tabela sem data de espécie alguma), usa a
// primeira chave sozinha — aí não há o que comparar, e uma coluna só nunca
// mistura tipo com ninguém.
export interface RecencyKey { key: string; isDate: boolean }

export function recencyExpression(keys: RecencyKey[]): string {
  const ident = (s: string) => `"${String(s).replace(/"/g, '""')}"`
  const datas = keys.filter((k) => k.isDate)
  const usadas = datas.length ? datas : keys.slice(0, 1)
  if (!usadas.length) return 'NULL'
  // greatest() só entre colunas do MESMO tipo — é a regra que faltava.
  return usadas.length > 1
    ? `greatest(${usadas.map((k) => ident(k.key)).join(', ')})`
    : ident(usadas[0].key)
}
