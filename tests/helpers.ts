// Auxiliares dos testes: dados falsos determinísticos, sqld temporário e os
// motores em que a mesma bateria roda. Nada aqui depende do relógio.
import { Database } from 'bun:sqlite'
import { createClient } from '@libsql/client'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Driver } from '../src'
import { bunSqlite, memoryScratch } from '../src/drivers/bun-sqlite'
import { d1, type D1Like } from '../src/drivers/d1'
import { http } from '../src/drivers/http'
import { libsql } from '../src/drivers/libsql'
import { STATEMENT_BREAKPOINT } from '../src/layouts/drizzle-kit'

const cleanups: (() => void | Promise<void>)[] = []

/** Roda no afterEach de cada arquivo de teste. */
export async function cleanup() {
  for (const fn of cleanups.splice(0).reverse()) await fn()
}

export function tempDir(prefix = 'migrator-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Junta comandos com a fronteira do drizzle-kit. */
export const breakpoints = (...statements: string[]) => statements.join(`\n${STATEMENT_BREAKPOINT}\n`)

/** Pasta no formato do drizzle-kit (journal + arquivos). */
export function drizzleFolder(files: Record<string, string>, journal = Object.keys(files)): string {
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  writeJournal(dir, journal)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, `${name}.sql`), content)
  return dir
}

export function writeJournal(dir: string, tags: string[]) {
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) }))
}

/** Pasta de `.sql` numerados. */
export function sqlDir(files: Record<string, string>): string {
  const dir = tempDir()
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, `${name}.sql`), content)
  return dir
}

// ---------------- dados falsos ----------------

/** Gerador pseudoaleatório com semente (mulberry32): mesmos dados a cada execução. */
export function seeded(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
  return { next, pick, int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)) }
}

const FIRST = ['ana', 'bruno', 'carla', 'diego', 'elisa', 'fabio', 'gabi', 'hugo', 'iris', 'joao', 'karen', 'lucas'] as const
const LAST = ['silva', 'souza', 'lima', 'costa', 'rocha', 'alves', 'dias', 'melo'] as const

export interface FakePerson {
  id: string
  name: string
  email: string
  note: string | null
}

/**
 * Pessoas falsas com e-mail no domínio reservado `example.test`. Algumas notas
 * têm aspas, ponto e vírgula e quebra de linha, para pegar SQL montado errado.
 */
export function fakePeople(count: number, seed = 42): FakePerson[] {
  const random = seeded(seed)
  const tricky = ["O'Brien; DROP TABLE x", 'linha 1\nlinha 2', '-- não é comentário', 'ação ✓ émoji 🎮', null]
  return Array.from({ length: count }, (_, index) => {
    const first = random.pick(FIRST)
    const last = random.pick(LAST)
    return {
      id: `p${String(index).padStart(5, '0')}`,
      name: `${first} ${last}`,
      email: `${first}.${last}${index}@example.test`,
      note: random.next() < 0.3 ? random.pick(tricky) : null,
    }
  })
}

// ---------------- sqld ----------------

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = server
  server.stop(true)
  return port
}

/** Sobe um `sqld` vazio numa porta livre e devolve a URL. Some no cleanup. */
export async function startSqld(): Promise<string> {
  const dir = tempDir('migrator-sqld-')
  const port = await freePort()
  const child = Bun.spawn(['sqld', '--db-path', join(dir, 'db'), '--http-listen-addr', `127.0.0.1:${port}`, '--no-welcome'], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  cleanups.push(async () => {
    child.kill()
    await child.exited
  })
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`sqld saiu: ${await new Response(child.stderr).text()}`)
    const ok = await fetch(`${url}/health`)
      .then((response) => response.ok)
      .catch(() => false)
    if (ok) return url
    await Bun.sleep(25)
  }
  throw new Error('sqld não respondeu')
}

// ---------------- motores ----------------

export interface Engine {
  driver: Driver
  /** SQL cru, fora do migrator (montar o cenário e conferir). */
  exec(sql: string, args?: (string | number | null)[]): Promise<void>
  value(sql: string): Promise<unknown>
  /** Liga as chaves estrangeiras da conexão de teste, quando o motor permite. */
  foreignKeysOn?: () => Promise<number>
}

/** D1 falso sobre `bun:sqlite`: o `batch` é uma transação, como no D1. */
function fakeD1(database: Database): D1Like {
  const prepared = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepared(sql, values),
    all: async () => ({ results: database.query(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: database.query(sql).run(...(args as never[])).changes } }),
    sql,
    args,
  })
  return {
    prepare: (sql) => prepared(sql) as never,
    batch: async (statements) => {
      database.transaction(() => {
        for (const statement of statements as unknown as { sql: string; args: never[] }[]) database.query(statement.sql).run(...statement.args)
      })()
      return []
    },
  }
}

export const engines: Record<string, () => Promise<Engine>> = {
  async 'bun-sqlite'() {
    const database = new Database(':memory:')
    database.run('PRAGMA foreign_keys = ON')
    cleanups.push(() => database.close())
    return {
      driver: bunSqlite(database),
      exec: async (sql, args = []) => void database.query(sql).run(...args),
      value: async (sql) => Object.values(database.query(sql).get() as object)[0],
      foreignKeysOn: async () => (database.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
    }
  },
  async libsql() {
    const path = join(tempDir(), 'test.db')
    const client = createClient({ url: `file:${path}`, intMode: 'number' })
    await client.execute('PRAGMA foreign_keys = ON')
    cleanups.push(() => client.close())
    return {
      driver: libsql(client),
      exec: async (sql, args = []) => void (await client.execute({ sql, args })),
      value: async (sql) => (await client.execute(sql)).rows[0]?.[0],
      foreignKeysOn: async () => Number((await client.execute('PRAGMA foreign_keys')).rows[0]?.[0]),
    }
  },
  async http() {
    const url = await startSqld()
    const driver = http({ url, scratch: memoryScratch })
    return {
      driver,
      exec: async (sql, args = []) => void (await driver.run({ sql, args })),
      value: async (sql) => Object.values((await driver.query({ sql }))[0] ?? {})[0],
    }
  },
}

/** D1 (falso) fica fora da bateria geral: ele recusa migration em banco com FK. */
export async function d1Engine(): Promise<Engine> {
  const database = new Database(':memory:')
  cleanups.push(() => database.close())
  return {
    driver: d1(fakeD1(database), { scratch: memoryScratch }),
    exec: async (sql, args = []) => void database.query(sql).run(...args),
    value: async (sql) => Object.values(database.query(sql).get() as object)[0],
  }
}
