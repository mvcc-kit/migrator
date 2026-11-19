// SQLite pelo `bun:sqlite`. Só Bun: não use em Workers.
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import type { Driver, Row, ScratchDriver, Statement } from '../core/types'
import { sqlite } from '../dialects/sqlite'

function bindings(statement: Statement): SQLQueryBindings[] {
  return [...(statement.args ?? [])] as SQLQueryBindings[]
}

/**
 * SQLite pelo `bun:sqlite`. As chaves estrangeiras só podem ser trocadas fora
 * de uma transação: `foreignKeys: false` as desliga em volta dela e devolve o
 * valor anterior no fim, mesmo com erro.
 */
export function bunSqlite(database: Database): Driver {
  return {
    dialect: sqlite(),
    async query(statement) {
      return database.query(statement.sql).all(...bindings(statement)) as Row[]
    },
    async run(statement) {
      return { changes: database.query(statement.sql).run(...bindings(statement)).changes }
    },
    async transaction(statements, { foreignKeys }) {
      const previous = database.query('PRAGMA foreign_keys').get() as { foreign_keys: number }
      if (!foreignKeys) database.run('PRAGMA foreign_keys = OFF')
      try {
        database.transaction(() => {
          for (const statement of statements) database.query(statement.sql).run(...bindings(statement))
        })()
      } finally {
        database.run(`PRAGMA foreign_keys = ${previous.foreign_keys ? 'ON' : 'OFF'}`)
      }
    },
    scratch: memoryScratch,
  }
}

/** Banco SQLite vazio em memória, para reaplicar o histórico. Serve a qualquer driver da família SQLite. */
export async function memoryScratch(): Promise<ScratchDriver> {
  const memory = new Database(':memory:')
  return {
    ...bunSqlite(memory),
    async dispose() {
      memory.close()
    },
  }
}
