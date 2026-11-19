// Família SQLite: arquivos SQLite, libSQL (`sqld`, Turso Cloud) e Cloudflare D1.
import { splitStatements, stripSql } from '../core/sql-text'
import type { Dialect, Driver, LintResult, Row, SchemaShape, SqlValue, Statement, TechnicalTables } from '../core/types'

const TRANSACTION_KEYWORDS = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'])

const FORBIDDEN: readonly [RegExp, string][] = [
  [/^PRAGMA\b/, 'PRAGMA é do migrator (as chaves estrangeiras já ficam desligadas em volta de cada migration)'],
  [/^(VACUUM|ATTACH|DETACH|REINDEX)\b/, 'comandos de manutenção ou ATTACH não rodam dentro de uma migration'],
]

/** Procurados no texto sem comentários e sem strings (`stripSql`). */
const DESTRUCTIVE: readonly [RegExp, string][] = [
  [/^DROP TABLE\b/, 'DROP TABLE'],
  [/^DROP VIEW\b/, 'DROP VIEW'],
  [/^ALTER TABLE\b.*\bDROP\b/, 'ALTER TABLE ... DROP COLUMN'],
  [/^ALTER TABLE\b.*\bRENAME\b/, 'ALTER TABLE ... RENAME'],
]

const TRIGGER = /^CREATE (TEMP |TEMPORARY )?TRIGGER\b/
const DELETE = /^(WITH\b.*?)?\bDELETE FROM\b/
const UPDATE = /^(WITH\b.*?)?\bUPDATE\b/
const WHERE = /\bWHERE\b/

/** Tabelas criadas pelo SQLite, libSQL, Cloudflare D1/Wrangler e Litestream. */
const ENGINE_TABLES = [
  (name: string) => name.startsWith('sqlite_'),
  (name: string) => name.startsWith('_cf_'),
  (name: string) => name.startsWith('_litestream'),
  (name: string) => name === 'd1_migrations' || name === '__d1_migrations',
  (name: string) => name === 'libsql_wasm_func_table',
]

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value))

function normalizeSql(value: unknown): string {
  return text(value)
    .replace(/["`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
    .toLowerCase()
}

/** Cláusulas CHECK com parênteses balanceados, lidas do CREATE TABLE. */
function checkClauses(createSql: string): string[] {
  const clauses: string[] = []
  const pattern = /\bcheck\s*\(/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(createSql))) {
    let depth = 1
    let index = match.index + match[0].length
    const start = index
    while (index < createSql.length && depth > 0) {
      if (createSql[index] === '(') depth += 1
      else if (createSql[index] === ')') depth -= 1
      index += 1
    }
    clauses.push(normalizeSql(createSql.slice(start, index - 1)))
  }
  return clauses.sort()
}

function partialPredicate(indexSql: unknown): string {
  const where = /\bwhere\b([\s\S]*)$/i.exec(text(indexSql))
  return where ? normalizeSql(where[1]) : ''
}

/**
 * Descrição estrutural que ignora formatação e mantém tudo o que muda o
 * comportamento: tipos, nulidade, defaults, chaves, ações das FKs, colunas,
 * unicidade e predicado dos índices, e CHECKs.
 */
async function describeSchema(driver: Driver, ignore: (name: string) => boolean): Promise<SchemaShape> {
  // Cinco consultas para o schema inteiro: drivers remotos pagam uma ida e volta cada.
  const forEachTable = 'FROM sqlite_schema m JOIN'
  // O D1 recusa funções pragma nas tabelas `_cf_*` dele (SQLITE_AUTH).
  const ownTables = "m.type = 'table' AND substr(m.name, 1, 4) <> '_cf_'"
  const [tables, columnRows, foreignKeyRows, indexRows, indexSql] = await Promise.all([
    driver.query({ sql: "SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name" }),
    driver.query({
      sql: `SELECT m.name AS tbl, p.name, p.type, p."notnull" AS not_null, p.dflt_value, p.pk ${forEachTable} pragma_table_info(m.name) p WHERE ${ownTables} ORDER BY m.name, p.cid`,
    }),
    driver.query({
      sql: `SELECT m.name AS tbl, f."table" AS target, f."from" AS source, f."to" AS target_column, f.on_update, f.on_delete ${forEachTable} pragma_foreign_key_list(m.name) f WHERE ${ownTables}`,
    }),
    driver.query({
      sql: `SELECT m.name AS tbl, il.name, il."unique" AS is_unique, il.origin, ii.seqno, ii.name AS column_name ${forEachTable} pragma_index_list(m.name) il LEFT JOIN pragma_index_info(il.name) ii WHERE ${ownTables} ORDER BY m.name, il.name, ii.seqno`,
    }),
    driver.query({ sql: "SELECT name, sql FROM sqlite_schema WHERE type = 'index'" }),
  ])
  const byTable = (rows: Row[]) => {
    const grouped = new Map<string, Row[]>()
    for (const row of rows) grouped.set(text(row.tbl), [...(grouped.get(text(row.tbl)) ?? []), row])
    return grouped
  }
  const columnsOf = byTable(columnRows)
  const foreignKeysOf = byTable(foreignKeyRows)
  const indexRowsOf = byTable(indexRows)
  const sqlOfIndex = new Map(indexSql.map((row) => [text(row.name), row.sql]))
  const shape: SchemaShape = {}
  for (const tableRow of tables) {
    const name = text(tableRow.name)
    if (ignore(name)) continue
    const indexColumns = new Map<string, { index: Row; columns: string[] }>()
    for (const row of indexRowsOf.get(name) ?? []) {
      const indexName = text(row.name)
      const entry = indexColumns.get(indexName) ?? { index: row, columns: [] }
      // Sem linha de info (LEFT JOIN) não há seqno; coluna de expressão tem nome NULL.
      if (row.seqno !== null && row.seqno !== undefined) entry.columns.push(text(row.column_name))
      indexColumns.set(indexName, entry)
    }
    const indexes: string[] = []
    for (const [indexName, { index, columns: on }] of indexColumns) {
      // Índices automáticos de UNIQUE/PK têm nomes que mudam conforme o motor.
      const label = text(index.origin) === 'c' ? indexName : `<${text(index.origin)}>`
      indexes.push(`${label} unique=${text(index.is_unique)} on(${on.join(',')}) where(${partialPredicate(sqlOfIndex.get(indexName))})`)
    }
    shape[name] = {
      columns: (columnsOf.get(name) ?? []).map(
        (row) =>
          `${text(row.name)} ${text(row.type).toUpperCase()} notnull=${text(row.not_null)} default=${normalizeSql(row.dflt_value)} pk=${text(row.pk)}`,
      ),
      foreignKeys: (foreignKeysOf.get(name) ?? [])
        .map(
          (row) =>
            `${text(row.source)}->${text(row.target)}.${text(row.target_column)} update=${text(row.on_update)} delete=${text(row.on_delete)}`,
        )
        .sort(),
      indexes: indexes.sort(),
      checks: checkClauses(text(tableRow.sql)),
    }
  }
  return shape
}

/** Classifica um comando: proibido (bloqueia sempre) ou destrutivo (precisa de marca e de flag). */
export function lint(statement: string): LintResult {
  const forbidden: string[] = []
  const destructive: string[] = []
  const code = stripSql(statement)
  const firstKeyword = /^[A-Z_]+/.exec(code)?.[0] ?? ''
  if (!firstKeyword) forbidden.push('comando vazio')
  if (TRANSACTION_KEYWORDS.has(firstKeyword)) forbidden.push('o controle de transação é do migrator')
  if (splitStatements(statement).length > 1) forbidden.push('mais de um comando; separe com --> statement-breakpoint ou ;')
  for (const [pattern, reason] of FORBIDDEN) if (pattern.test(code)) forbidden.push(reason)
  for (const [pattern, label] of DESTRUCTIVE) if (pattern.test(code)) destructive.push(label)
  // O corpo de um trigger é comportamento futuro, não uma alteração de dados agora.
  if (!TRIGGER.test(code)) {
    if (DELETE.test(code) && !WHERE.test(code)) destructive.push('DELETE sem WHERE')
    if (UPDATE.test(code) && !WHERE.test(code)) destructive.push('UPDATE sem WHERE')
  }
  return { forbidden, destructive }
}

const GUARD_MARKER = 'migration-guard'

/** Família SQLite: arquivos SQLite, libSQL (`sqld`, Turso Cloud) e Cloudflare D1. */
export function sqlite(): Dialect {
  return {
    name: 'sqlite',
    createTables(tables: TechnicalTables): Statement[] {
      return [
        { sql: `CREATE TABLE IF NOT EXISTS "${tables.meta}" (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)` },
        {
          sql: `CREATE TABLE IF NOT EXISTS "${tables.history}" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, chain TEXT NOT NULL, schema_hash TEXT NOT NULL, applied_at TEXT NOT NULL, applied_by TEXT NOT NULL, app_commit TEXT NOT NULL, tool_version TEXT NOT NULL)`,
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS "${tables.lock}" (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), owner TEXT NOT NULL, acquired_at TEXT NOT NULL)`,
        },
      ]
    },
    tableExists(name: string): Statement {
      return { sql: "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?", args: [name] }
    },
    listTables(): Statement {
      return { sql: "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name" }
    },
    isEngineTable(name: string) {
      return ENGINE_TABLES.some((matches) => matches(name))
    },
    // O SQLite não tem RAISE fora de trigger: um erro de JSON proposital aborta a
    // transação, e `isGuardAbort` o reconhece.
    abortUnless(condition: string, args: readonly SqlValue[] = []): Statement {
      return { sql: `SELECT CASE WHEN ${condition} THEN 1 ELSE json_extract('${GUARD_MARKER}', '$') END`, args }
    },
    foreignKeysValid: 'NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)',
    lint,
    describeSchema,
    isGuardAbort(error: unknown) {
      return /malformed JSON/i.test(error instanceof Error ? error.message : String(error))
    },
  }
}
