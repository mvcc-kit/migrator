// Contratos entre o núcleo e as peças trocáveis (layout, dialeto e driver).
// O núcleo não lê arquivo nem fala com banco: só usa estas interfaces.

export type SqlValue = string | number | bigint | null | Uint8Array

export interface Statement {
  sql: string
  args?: readonly SqlValue[]
}

export type Row = Record<string, unknown>

/** Uma conexão com um banco. Sabe rodar SQL; não sabe nada de migrations. */
export interface Driver {
  /** Dialeto usado quando a configuração não indica outro. */
  readonly dialect: Dialect
  query(statement: Statement): Promise<Row[]>
  run(statement: Statement): Promise<{ changes: number }>
  /**
   * Roda todos os comandos de forma atômica: ou todos confirmam, ou nenhum.
   * Com `foreignKeys: false`, o motor deixa de checar chaves estrangeiras só
   * dentro desta transação (a guarda do dialeto confere tudo antes do commit).
   */
  transaction(statements: readonly Statement[], options: { foreignKeys: boolean }): Promise<void>
  /**
   * Banco vazio e descartável do mesmo motor, para reaplicar o histórico e
   * comparar o schema. Driver que não tem um (D1, HTTP dentro de um Worker)
   * deixa sem; aí o `scratch` vem da configuração do migrator.
   */
  scratch?: () => Promise<ScratchDriver>
}

export interface ScratchDriver extends Driver {
  dispose(): Promise<void>
}

/** Uma migration como o layout encontrou, antes de qualquer acesso ao banco. */
export interface MigrationSource {
  /** Nome completo e único (ex.: `0004_meal_reminders`). */
  name: string
  /** Conteúdo exato do arquivo. O checksum cobre tudo (com fim de linha normalizado). */
  content: string
  /** Comandos separados nas fronteiras do layout. */
  statements: string[]
}

export interface LayoutResult {
  /** Na ordem de aplicação. */
  migrations: MigrationSource[]
  /** Bloqueiam todos os comandos (arquivo faltando, ordem quebrada). */
  problems: string[]
  /** Só avisam (arquivo fora do padrão, ignorado). */
  warnings: string[]
}

/** Onde as migrations estão e em que ordem. */
export interface Layout {
  readonly name: string
  load(): Promise<LayoutResult>
}

export interface TechnicalTables {
  history: string
  lock: string
  meta: string
}

export interface LintResult {
  forbidden: string[]
  destructive: string[]
}

/** Todo o SQL que depende do motor. */
export interface Dialect {
  readonly name: string
  createTables(tables: TechnicalTables): Statement[]
  /** Devolve uma linha quando a tabela existe; nenhuma quando não existe. */
  tableExists(name: string): Statement
  /** Linhas com a coluna `name`: todas as tabelas do banco. */
  listTables(): Statement
  /** Tabelas do motor ou do provedor, nunca da aplicação. */
  isEngineTable(name: string): boolean
  /** Comando que aborta a transação em volta, a menos que `condition` seja verdadeira. */
  abortUnless(condition: string, args?: readonly SqlValue[]): Statement
  /** Condição verdadeira quando nenhuma chave estrangeira está violada. */
  readonly foreignKeysValid: string
  lint(statement: string): LintResult
  /** Descrição estrutural do schema: ignora formatação e as tabelas ignoradas. */
  describeSchema(driver: Driver, ignore: (name: string) => boolean): Promise<SchemaShape>
  /** Verdadeiro quando o erro veio de um `abortUnless`. */
  isGuardAbort(error: unknown): boolean
}

export interface TableShape {
  columns: string[]
  foreignKeys: string[]
  indexes: string[]
  checks: string[]
}

export type SchemaShape = Record<string, TableShape>

export class MigrationError extends Error {
  constructor(message: string) {
    super(`migrator: ${message}`)
    this.name = 'MigrationError'
  }
}
