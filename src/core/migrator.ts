// Núcleo: confere e aplica migrations. Não conhece arquivo, motor nem SDK; recebe
// layout, dialeto e driver (ADR.md, M1). Roda em qualquer lugar com Web Crypto.
import pkg from '../../package.json' with { type: 'json' }
import { chainHash, checksumOf, diffSchemas, schemaHash } from './hash'
import { MigrationError, type Dialect, type Driver, type Layout, type MigrationSource, type ScratchDriver, type Statement, type TechnicalTables } from './types'

export const TOOL_VERSION: string = pkg.version
/** Versão do formato das tabelas técnicas, gravada em `<table>_meta`. */
const FORMAT = '1'
const DESTRUCTIVE_MARKER = /^--\s*migration:destructive\s+(\S.*)$/m
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

export interface MigratorConfig {
  driver: Driver
  layout: Layout
  /** Padrão: o dialeto do driver. */
  dialect?: Dialect
  /** Banco descartável para reaplicar o histórico. Padrão: `driver.scratch`. */
  scratch?: () => Promise<ScratchDriver>
  /** Tabela de histórico; `<table>_lock` e `<table>_meta` derivam dela. */
  table?: string
  /** Nome do ambiente gravado pelo `init()` e conferido em todo comando. */
  identity?: string
  /** Outras tabelas que não são schema da aplicação (nome exato ou `prefixo*`). */
  ignoreTables?: readonly string[]
  /** Quem aplica, gravado no histórico (ex.: `ci`). */
  actor?: string
  /** Commit da aplicação, gravado no histórico. */
  commit?: string
  /** Relógio. Padrão: `new Date()`. Os testes passam um relógio falso. */
  now?: () => Date
}

export interface AppliedRecord {
  name: string
  checksum: string
  chain: string
  schemaHash: string
  appliedAt: string
  appliedBy: string
  appCommit: string
}

export interface StatusReport {
  identity: string | null
  initialized: boolean
  applied: string[]
  history: AppliedRecord[]
  pending: string[]
  /** Comandos destrutivos das pendentes (precisam da marca no arquivo e de `allowDestructive`). */
  destructive: Record<string, string[]>
  problems: string[]
  warnings: string[]
  lock: { owner: string; acquiredAt: string } | null
}

export interface MigrateOptions {
  allowDestructive?: boolean
  /** Só roda migration que já foi aplicada em outro ambiente. */
  promotion?: { from: string; applied: readonly string[] }
  /** Dono da trava. Padrão: `<commit>:<uuid>`. */
  owner?: string
}

export interface MigrateResult {
  applied: { name: string; durationMs: number }[]
}

export interface Migrator {
  readonly tables: TechnicalTables
  init(options?: { adoptExisting?: boolean }): Promise<void>
  status(): Promise<StatusReport>
  migrate(options?: MigrateOptions): Promise<MigrateResult>
  /** Registra como aplicadas, sem rodar, as migrations até `through`, se o schema já for o delas. */
  adopt(through: string): Promise<{ adopted: string[] }>
  unlock(owner: string): Promise<void>
}

interface PreparedMigration extends MigrationSource {
  checksum: string
  chain: string
  destructiveReason: string | null
}

const quote = (name: string) => `"${name}"`
const text = (value: unknown) => (value === null || value === undefined ? '' : String(value))
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function prepare(sources: readonly MigrationSource[]): Promise<PreparedMigration[]> {
  let previous = ''
  const prepared: PreparedMigration[] = []
  for (const source of sources) {
    const checksum = await checksumOf(source.content)
    previous = await chainHash(previous, source.name, checksum)
    prepared.push({ ...source, checksum, chain: previous, destructiveReason: DESTRUCTIVE_MARKER.exec(source.content)?.[1]?.trim() ?? null })
  }
  return prepared
}

function matcher(patterns: readonly string[]) {
  return (name: string) => patterns.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))
}

export function createMigrator(config: MigratorConfig): Migrator {
  const { driver, layout } = config
  const dialect = config.dialect ?? driver.dialect
  const table = config.table ?? '__migrations'
  if (!IDENTIFIER.test(table)) throw new MigrationError(`nome de tabela inválido "${table}": use letras, dígitos e _`)
  if (config.identity !== undefined && !config.identity.trim()) throw new MigrationError('identity vazia: dê um nome ao ambiente ou deixe sem')
  const tables: TechnicalTables = { history: table, lock: `${table}_lock`, meta: `${table}_meta` }
  const actor = config.actor ?? 'unknown'
  const commit = config.commit ?? 'unknown'
  const now = config.now ?? (() => new Date())
  const makeScratch = config.scratch ?? driver.scratch
  const extraIgnored = matcher(config.ignoreTables ?? [])
  const ignore = (name: string) =>
    dialect.isEngineTable(name) || name === tables.history || name === tables.lock || name === tables.meta || extraIgnored(name)

  async function tableExists(name: string) {
    return (await driver.query(dialect.tableExists(name))).length > 0
  }

  async function storedIdentity(): Promise<string | null> {
    if (!(await tableExists(tables.meta))) return null
    const rows = await driver.query({ sql: `SELECT value FROM ${quote(tables.meta)} WHERE key = 'identity'` })
    return rows[0] ? text(rows[0].value) : null
  }

  async function assertIdentity() {
    if (!config.identity) return
    const stored = await storedIdentity()
    if (stored !== config.identity)
      throw new MigrationError(`banco de outro ambiente: esperado "${config.identity}", o banco é "${stored ?? 'sem marca'}"`)
  }

  async function assertInitialized() {
    if (!(await tableExists(tables.history))) throw new MigrationError(`banco não inicializado (sem a tabela ${tables.history}); rode init`)
  }

  async function readHistory(): Promise<AppliedRecord[]> {
    const rows = await driver.query({
      sql: `SELECT name, checksum, chain, schema_hash, applied_at, applied_by, app_commit FROM ${quote(tables.history)} ORDER BY id`,
    })
    return rows.map((row) => ({
      name: text(row.name),
      checksum: text(row.checksum),
      chain: text(row.chain),
      schemaHash: text(row.schema_hash),
      appliedAt: text(row.applied_at),
      appliedBy: text(row.applied_by),
      appCommit: text(row.app_commit),
    }))
  }

  async function readLock() {
    const rows = await driver.query({ sql: `SELECT owner, acquired_at FROM ${quote(tables.lock)} WHERE id = 1` })
    return rows[0] ? { owner: text(rows[0].owner), acquiredAt: text(rows[0].acquired_at) } : null
  }

  async function openScratch(): Promise<ScratchDriver> {
    if (!makeScratch)
      throw new MigrationError(
        'este driver não tem banco descartável para conferir o schema; passe scratch na configuração (ex.: memoryScratch de @mvcc-kit/migrator/drivers/bun-sqlite)',
      )
    return makeScratch()
  }

  /** Reaplica migrations no banco descartável e devolve o schema depois delas. */
  async function replay(scratch: ScratchDriver, migrations: readonly PreparedMigration[]) {
    for (const migration of migrations) {
      try {
        await scratch.transaction(
          migration.statements.map((sql) => ({ sql })),
          { foreignKeys: false },
        )
      } catch (error) {
        throw new MigrationError(`${migration.name} falhou no banco descartável: ${messageOf(error)}`)
      }
    }
    return dialect.describeSchema(scratch, ignore)
  }

  /** Inspeção completa. O banco descartável volta reaplicado até o histórico atual. */
  async function inspect(checkDrift = true) {
    const loaded = await layout.load()
    const files = await prepare(loaded.migrations)
    const report: StatusReport = {
      identity: null,
      initialized: false,
      applied: [],
      history: [],
      pending: [],
      destructive: {},
      problems: [...loaded.problems],
      warnings: [...loaded.warnings],
      lock: null,
    }
    if (!(await tableExists(tables.history))) {
      report.problems.push(`banco não inicializado (sem a tabela ${tables.history}); rode init`)
      return { report, files, scratch: null }
    }
    await assertIdentity()
    report.initialized = true
    report.identity = await storedIdentity()
    report.history = await readHistory()
    report.applied = report.history.map((record) => record.name)
    report.lock = await readLock()

    const byName = new Map(files.map((file) => [file.name, file]))
    report.history.forEach((record, index) => {
      const file = byName.get(record.name)
      if (!file) report.problems.push(`a migration aplicada ${record.name} não tem arquivo`)
      else if (file.checksum !== record.checksum) report.problems.push(`a migration aplicada ${record.name} foi editada (checksum diferente)`)
      else if (files[index]?.name !== record.name) report.problems.push(`a migration aplicada ${record.name} está fora da ordem do layout ${layout.name}`)
      else if (file.chain !== record.chain)
        report.problems.push(`cadeia do histórico quebrada em ${record.name} (uma linha do histórico foi alterada ou removida)`)
    })
    if (report.problems.length) return { report, files, scratch: null }

    const pending = files.slice(report.history.length)
    report.pending = pending.map((file) => file.name)
    for (const migration of pending) {
      const destructive: string[] = []
      migration.statements.forEach((statement, index) => {
        const lint = dialect.lint(statement)
        for (const reason of lint.forbidden) report.problems.push(`${migration.name} comando ${index + 1}: ${reason}`)
        for (const label of lint.destructive) destructive.push(`comando ${index + 1}: ${label}`)
      })
      if (!migration.statements.length) report.problems.push(`${migration.name}: a migration não tem comandos`)
      if (destructive.length) report.destructive[migration.name] = destructive
    }

    const scratch = await openScratch()
    try {
      const expected = await replay(scratch, files.slice(0, report.history.length))
      if (checkDrift) {
        const differences = diffSchemas(expected, await dialect.describeSchema(driver, ignore))
        report.problems.push(...differences.map((difference) => `schema diferente do histórico: ${difference}`))
      }
    } catch (error) {
      await scratch.dispose()
      throw error
    }
    return { report, files, scratch }
  }

  function historyInsert(migration: PreparedMigration, expectedHash: string, appliedAt: string): Statement {
    return {
      sql: `INSERT INTO ${quote(tables.history)} (name, checksum, chain, schema_hash, applied_at, applied_by, app_commit, tool_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [migration.name, migration.checksum, migration.chain, expectedHash, appliedAt, actor, commit, TOOL_VERSION],
    }
  }

  /**
   * Toma a trava, roda `work` e devolve a trava. A trava vem antes de ler o
   * histórico: duas execuções ao mesmo tempo nunca calculam as mesmas pendentes.
   * Se devolver a trava falhar, o erro diz o dono para o `unlock`, sem esconder
   * o erro do trabalho.
   */
  async function withLock<T>(owner: string, work: () => Promise<T>): Promise<T> {
    try {
      await driver.run({
        sql: `INSERT INTO ${quote(tables.lock)} (id, owner, acquired_at) VALUES (1, ?, ?)`,
        args: [owner, now().toISOString()],
      })
    } catch (error) {
      const held = await readLock().catch(() => null)
      if (held)
        throw new MigrationError(
          `trava ocupada por ${held.owner} desde ${held.acquiredAt}; use unlock só depois de confirmar que essa execução parou`,
        )
      throw new MigrationError(`não foi possível tomar a trava: ${messageOf(error)}`)
    }
    let result: T
    try {
      result = await work()
    } catch (error) {
      await release(owner).catch((releaseError) => {
        if (error instanceof Error) error.message += `\n(e a trava não foi devolvida: ${messageOf(releaseError)}; rode unlock("${owner}"))`
      })
      throw error
    }
    try {
      await release(owner)
    } catch (error) {
      throw new MigrationError(`trabalho concluído, mas a trava não foi devolvida (${messageOf(error)}); rode unlock("${owner}")`)
    }
    return result
  }

  async function release(owner: string) {
    await driver.run({ sql: `DELETE FROM ${quote(tables.lock)} WHERE id = 1 AND owner = ?`, args: [owner] })
  }

  async function applyOne(migration: PreparedMigration, scratch: ScratchDriver, owner: string) {
    const expected = await replay(scratch, [migration])
    const expectedHash = await schemaHash(expected)
    const started = performance.now()
    try {
      await driver.transaction(
        [
          dialect.abortUnless(`EXISTS (SELECT 1 FROM ${quote(tables.lock)} WHERE id = 1 AND owner = ?)`, [owner]),
          ...migration.statements.map((sql) => ({ sql })),
          dialect.abortUnless(dialect.foreignKeysValid),
          historyInsert(migration, expectedHash, now().toISOString()),
        ],
        { foreignKeys: false },
      )
    } catch (error) {
      // O commit pode ter acontecido antes de a conexão cair: o histórico decide,
      // nunca se reaplica DDL às cegas.
      const recorded = (await readHistory()).some((record) => record.name === migration.name)
      if (!recorded) {
        if (dialect.isGuardAbort(error))
          throw new MigrationError(`${migration.name}: abortada por uma guarda (trava perdida ou chave estrangeira violada); nada foi aplicado`)
        throw new MigrationError(`${migration.name}: ${messageOf(error)}; nada foi aplicado`)
      }
    }
    const durationMs = Math.round(performance.now() - started)
    const differences = diffSchemas(expected, await dialect.describeSchema(driver, ignore))
    if (differences.length)
      throw new MigrationError(
        `${migration.name} foi aplicada, mas o schema ficou diferente do esperado; parando:\n- ${differences.join('\n- ')}`,
      )
    return { name: migration.name, durationMs }
  }

  return {
    tables,

    async init(options = {}) {
      const stored = await storedIdentity()
      if (stored !== null && config.identity && stored !== config.identity)
        throw new MigrationError(`o banco está marcado como "${stored}"; não vou inicializá-lo como "${config.identity}"`)
      if (!(await tableExists(tables.history)) && !options.adoptExisting) {
        const existing = (await driver.query(dialect.listTables())).map((row) => text(row.name)).filter((name) => !ignore(name))
        if (existing.length)
          throw new MigrationError(
            `o banco já tem tabelas (${existing.slice(0, 5).join(', ')}) e não tem ${tables.history}; não vou adotá-lo sem pedido (use init({ adoptExisting: true }) e adopt())`,
          )
      }
      const current = (await tableExists(tables.meta)) ? await driver.query({ sql: `SELECT key FROM ${quote(tables.meta)}` }) : []
      const has = new Set(current.map((row) => text(row.key)))
      const values: [string, string | undefined][] = [
        ['identity', config.identity],
        ['dialect', dialect.name],
        ['format', FORMAT],
      ]
      const meta: Statement[] = values
        .filter(([key, value]) => value !== undefined && !has.has(key))
        .map(([key, value]) => ({ sql: `INSERT INTO ${quote(tables.meta)} (key, value) VALUES (?, ?)`, args: [key, value!] }))
      await driver.transaction([...dialect.createTables(tables), ...meta], { foreignKeys: true })
    },

    async status() {
      const { report, scratch } = await inspect()
      await scratch?.dispose()
      return report
    },

    async migrate(options = {}) {
      await assertInitialized()
      await assertIdentity()
      const owner = options.owner ?? `${commit}:${crypto.randomUUID()}`
      return withLock(owner, async () => {
        const { report, files, scratch } = await inspect()
        if (!scratch || report.problems.length) {
          await scratch?.dispose()
          throw new MigrationError(`bloqueado:\n- ${report.problems.join('\n- ')}`)
        }
        try {
          const pending = files.slice(report.history.length)
          for (const migration of pending) {
            const destructive = report.destructive[migration.name]
            if (destructive && !(options.allowDestructive && migration.destructiveReason))
              throw new MigrationError(
                `${migration.name} é destrutiva (${destructive.join('; ')}); precisa de "-- migration:destructive <motivo>" no arquivo e de allowDestructive`,
              )
            if (options.promotion && !options.promotion.applied.includes(migration.name))
              throw new MigrationError(`${migration.name} ainda não foi aplicada em ${options.promotion.from}`)
          }
          const applied: MigrateResult['applied'] = []
          for (const migration of pending) applied.push(await applyOne(migration, scratch, owner))
          return { applied }
        } finally {
          await scratch.dispose()
        }
      })
    },

    async adopt(through) {
      await assertInitialized()
      await assertIdentity()
      return withLock(`adopt:${crypto.randomUUID()}`, async () => {
        // O schema é comparado abaixo com as migrations adotadas, não com o histórico vazio.
        const { report, files, scratch } = await inspect(false)
        try {
          if (!scratch || report.problems.length) throw new MigrationError(`bloqueado:\n- ${report.problems.join('\n- ')}`)
          if (report.history.length) throw new MigrationError('adopt só funciona com o histórico vazio')
          const index = files.findIndex((file) => file.name === through)
          if (index === -1) throw new MigrationError(`migration desconhecida ${through}`)
          const adopted = files.slice(0, index + 1)
          const expected = await replay(scratch, adopted)
          const differences = diffSchemas(expected, await dialect.describeSchema(driver, ignore))
          if (differences.length)
            throw new MigrationError(`o schema não é o das migrations até ${through}; nada foi registrado:\n- ${differences.join('\n- ')}`)
          // Sem reaplicar passo a passo, as impressões intermediárias são desconhecidas:
          // cada linha adotada guarda a impressão conferida agora.
          const hash = await schemaHash(expected)
          const at = now().toISOString()
          await driver.transaction(
            adopted.map((migration) => historyInsert(migration, hash, at)),
            { foreignKeys: true },
          )
          return { adopted: adopted.map((migration) => migration.name) }
        } finally {
          await scratch?.dispose()
        }
      })
    },

    async unlock(owner) {
      await assertIdentity()
      const result = await driver.run({ sql: `DELETE FROM ${quote(tables.lock)} WHERE id = 1 AND owner = ?`, args: [owner] })
      if (result.changes !== 1) throw new MigrationError('não existe trava com esse dono')
    },
  }
}
