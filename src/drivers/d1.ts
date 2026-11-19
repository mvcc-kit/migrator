// Cloudflare D1: o binding do Worker, o do `getPlatformProxy` do wrangler ou
// qualquer cliente com o mesmo formato. Não importa nada só do Bun.
import type { Driver, ScratchDriver, SqlValue, Statement } from '../core/types'
import { sqlite } from '../dialects/sqlite'

type D1Value = string | number | null | ArrayBuffer

interface D1PreparedLike {
  bind(...values: D1Value[]): D1PreparedLike
  all(): Promise<{ results?: unknown[] }>
  run(): Promise<{ meta: { changes?: number } }>
}

/** O que o driver usa de um banco D1. */
export interface D1Like {
  prepare(sql: string): D1PreparedLike
  batch(statements: D1PreparedLike[]): Promise<unknown[]>
}

export interface D1DriverOptions {
  /**
   * Banco descartável para reaplicar o histórico. O D1 não cria bancos na hora:
   * nas ferramentas, use `memoryScratch` de `@mvcc-kit/migrator/drivers/bun-sqlite` (o D1
   * roda SQLite). Sem ele, passe `scratch` na configuração do migrator.
   */
  scratch?: () => Promise<ScratchDriver>
}

function toD1Value(value: SqlValue): D1Value {
  if (typeof value === 'bigint') {
    if (!Number.isSafeInteger(Number(value))) throw new Error('migrator: o D1 não aceita inteiro fora da faixa segura')
    return Number(value)
  }
  if (value instanceof Uint8Array) return value.slice().buffer
  return value
}

/**
 * Cloudflare D1. O `batch()` é a transação do D1: um comando que falha desfaz o
 * lote inteiro.
 *
 * O D1 não desliga chaves estrangeiras: `PRAGMA defer_foreign_keys` só adia a
 * checagem, e as ações ON DELETE ainda disparam (reconstruir uma tabela pai
 * apagaria os filhos). Por isso migration (`foreignKeys: false`) é recusada
 * enquanto alguma tabela tiver chave estrangeira. Feito para bancos pequenos, sem FK.
 */
export function d1(database: D1Like, options: D1DriverOptions = {}): Driver {
  const prepare = (statement: Statement) => {
    const query = database.prepare(statement.sql)
    const args = (statement.args ?? []).map(toD1Value)
    return args.length ? query.bind(...args) : query
  }
  return {
    dialect: sqlite(),
    async query(statement) {
      const { results } = await prepare(statement).all()
      return (results ?? []) as Record<string, unknown>[]
    },
    async run(statement) {
      const { meta } = await prepare(statement).run()
      return { changes: meta.changes ?? 0 }
    },
    async transaction(statements, { foreignKeys }) {
      if (!foreignKeys) {
        const { results } = await database
          .prepare(
            "SELECT m.name FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND substr(m.name, 1, 4) <> '_cf_' LIMIT 1",
          )
          .all()
        if (results?.length)
          throw new Error(
            'migrator: o driver D1 não roda migrations em banco com chave estrangeira: o D1 não as desliga, e as ações ON DELETE disparariam',
          )
      }
      await database.batch(statements.map(prepare))
    },
    ...(options.scratch ? { scratch: options.scratch } : {}),
  }
}
