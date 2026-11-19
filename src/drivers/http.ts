// libSQL pelo HTTP (protocolo Hrana v2, `/v2/pipeline`), só com `fetch`: Turso
// Cloud e `sqld` local, sem `@libsql/client`. Roda em Bun, Node e Workers.
import type { Driver, Row, ScratchDriver, SqlValue, Statement } from '../core/types'
import { sqlite } from '../dialects/sqlite'

export interface HttpDriverOptions {
  /** `libsql://…` (como o painel do Turso mostra), `https://…` ou `http://` só em loopback. */
  url: string
  /** Token do banco. Obrigatório fora do loopback. Nunca aparece em mensagens de erro. */
  authToken?: string
  /** Limite de cada pedido. Padrão: 30 s (uma migration pode ser lenta). */
  timeoutMs?: number
  fetch?: typeof fetch
  /** Banco descartável. Nas ferramentas: `memoryScratch` de `@mvcc-kit/migrator/drivers/bun-sqlite`. */
  scratch?: () => Promise<ScratchDriver>
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Confere o endereço e devolve a base HTTP. O erro nunca mostra o token. */
export function resolveHttpUrl(url: string, authToken?: string): string {
  let parsed: URL
  try {
    // O URL do padrão não deixa trocar um esquema especial por outro: a troca é no texto.
    parsed = new URL(url.trim().replace(/^libsql:\/\//i, 'https://'))
  } catch {
    throw new Error('migrator: url do banco ausente ou inválida')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('migrator: a url do banco precisa ser libsql://, https:// ou http://')
  if (parsed.username || parsed.password) throw new Error('migrator: não ponha credenciais na url; use authToken')
  const local = LOOPBACK.has(parsed.hostname)
  if (!local && parsed.protocol === 'http:') throw new Error('migrator: banco remoto exige https')
  if (!local && !authToken) throw new Error('migrator: authToken é obrigatório para banco remoto')
  return parsed.origin + parsed.pathname.replace(/\/$/, '')
}

type HranaValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string }

interface HranaStmt {
  sql: string
  args?: HranaValue[]
  want_rows?: boolean
}

interface HranaResult {
  cols: { name: string | null }[]
  rows: HranaValue[][]
  affected_row_count: number
}

interface HranaError {
  message: string
  code?: string | null
}

type PipelineResult = { type: 'ok'; response: { type: string; result?: unknown } } | { type: 'error'; error: HranaError }

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

export function toHrana(value: SqlValue): HranaValue {
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') return { type: 'text', value }
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() }
  if (value instanceof Uint8Array) return { type: 'blob', base64: toBase64(value) }
  if (!Number.isFinite(value)) throw new Error('migrator: número inválido (NaN ou infinito)')
  return Number.isInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value }
}

/** Inteiro dentro da faixa segura vira `number`; fora dela, `bigint`. */
export function fromHrana(value: HranaValue): unknown {
  switch (value.type) {
    case 'null':
      return null
    case 'integer': {
      const big = BigInt(value.value)
      return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big
    }
    case 'float':
    case 'text':
      return value.value
    case 'blob':
      return fromBase64(value.base64)
  }
}

const toStmt = (statement: Statement, wantRows = true): HranaStmt => ({
  sql: statement.sql,
  args: (statement.args ?? []).map(toHrana),
  want_rows: wantRows,
})

function toRows(result: HranaResult): Row[] {
  const names = result.cols.map((col, index) => col.name ?? String(index))
  return result.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, fromHrana(row[index]!)])))
}

class HranaFailure extends Error {
  constructor(error: HranaError) {
    super(error.code ? `${error.message} (${error.code})` : error.message)
    this.name = 'HranaFailure'
  }
}

/** Driver libSQL pelo HTTP. Cada chamada é um pipeline fechado: sem estado entre chamadas. */
export function http(options: HttpDriverOptions): Driver {
  const base = resolveHttpUrl(options.url, options.authToken)
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  async function pipeline(requests: unknown[]): Promise<PipelineResult[]> {
    let response: Response
    try {
      response = await doFetch(`${base}/v2/pipeline`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.authToken ? { authorization: `Bearer ${options.authToken}` } : {}),
        },
        body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(
        error instanceof Error && error.name === 'TimeoutError' ? `migrator: o banco não respondeu em ${timeoutMs} ms` : 'migrator: banco inacessível',
      )
    }
    if (response.status === 401 || response.status === 403) throw new Error(`migrator: o banco recusou o acesso (HTTP ${response.status}); confira o token`)
    if (!response.ok) throw new Error(`migrator: o banco respondeu HTTP ${response.status}`)
    let body: { results?: PipelineResult[] }
    try {
      body = (await response.json()) as { results?: PipelineResult[] }
    } catch {
      throw new Error('migrator: resposta do banco não é JSON')
    }
    if (!Array.isArray(body.results) || body.results.length !== requests.length + 1) throw new Error('migrator: resposta do banco incompleta')
    return body.results
  }

  function executeResult(result: PipelineResult): HranaResult {
    if (result.type === 'error') throw new HranaFailure(result.error)
    if (result.response.type !== 'execute' || !result.response.result) throw new Error('migrator: resposta do banco inesperada')
    return result.response.result as HranaResult
  }

  async function execute(statement: Statement): Promise<HranaResult> {
    const [result] = await pipeline([{ type: 'execute', stmt: toStmt(statement) }])
    return executeResult(result!)
  }

  /**
   * BEGIN, cada comando só se o anterior deu certo, COMMIT só se todos deram,
   * senão ROLLBACK. Sem chaves estrangeiras, o lote começa com o PRAGMA (que só
   * muda fora de transação, na conexão deste pedido): o BEGIN depende dele, e o
   * PRAGMA de volta roda sempre no fim.
   */
  function transactionBatch(statements: readonly Statement[], foreignKeys: boolean) {
    const ok = (step: number) => ({ type: 'ok', step })
    const steps: { stmt: HranaStmt; condition?: unknown }[] = []
    if (!foreignKeys) steps.push({ stmt: { sql: 'PRAGMA foreign_keys = OFF' } })
    const begin = steps.length
    steps.push({ stmt: { sql: 'BEGIN IMMEDIATE' }, ...(foreignKeys ? {} : { condition: ok(begin - 1) }) })
    statements.forEach((statement, index) => steps.push({ stmt: toStmt(statement, false), condition: ok(begin + index) }))
    const commit = steps.length
    steps.push({ stmt: { sql: 'COMMIT' }, condition: ok(commit - 1) })
    steps.push({ stmt: { sql: 'ROLLBACK' }, condition: { type: 'and', conds: [ok(begin), { type: 'not', cond: ok(commit) }] } })
    if (!foreignKeys) steps.push({ stmt: { sql: 'PRAGMA foreign_keys = ON' } })
    return { request: { type: 'batch', batch: { steps } }, commit }
  }

  function checkBatch(result: PipelineResult, commit: number) {
    if (result.type === 'error') throw new HranaFailure(result.error)
    const batch = result.response.result as { step_results?: unknown[]; step_errors?: (HranaError | null)[] } | undefined
    if (!batch?.step_results || !batch.step_errors) throw new Error('migrator: resposta do banco inesperada')
    const failure = batch.step_errors.find((error) => error)
    if (failure) throw new HranaFailure(failure)
    // Sem resultado no passo do COMMIT, a transação não confirmou.
    if (!batch.step_results[commit]) throw new Error('migrator: a transação não confirmou')
  }

  const driver: Driver = {
    dialect: sqlite(),
    async query(statement) {
      return toRows(await execute(statement))
    },
    async run(statement) {
      return { changes: (await execute(statement)).affected_row_count }
    },
    async transaction(statements, { foreignKeys }) {
      if (!statements.length) return
      const { request, commit } = transactionBatch(statements, foreignKeys)
      const [result] = await pipeline([request])
      checkBatch(result!, commit)
    },
  }
  if (options.scratch) driver.scratch = options.scratch
  return driver
}
