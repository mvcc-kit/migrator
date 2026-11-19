import { afterEach, describe, expect, it } from 'bun:test'
import { fromHrana, http, resolveHttpUrl, toHrana } from '../src/drivers/http'
import { cleanup, startSqld } from './helpers'

afterEach(cleanup)

const TOKEN = 'tok_super_secreto_123'

/** fetch falso que guarda o pedido e responde o que o teste mandar. */
function fakeFetch(reply: (body: { requests: unknown[] }) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string>; body: { requests: unknown[] } }[] = []
  const doFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push({ url, headers: init.headers as Record<string, string>, body })
    return reply(body)
  }) as unknown as typeof fetch
  return { doFetch, calls }
}

describe('resolveHttpUrl', () => {
  it('aceita libsql://, https:// e http:// só em loopback', () => {
    expect(resolveHttpUrl('libsql://db.example.test', 't')).toBe('https://db.example.test')
    expect(resolveHttpUrl('https://db.example.test/', 't')).toBe('https://db.example.test')
    expect(resolveHttpUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(() => resolveHttpUrl('http://db.example.test', 't')).toThrow('exige https')
    expect(() => resolveHttpUrl('https://db.example.test')).toThrow('authToken é obrigatório')
    expect(() => resolveHttpUrl('ws://db.example.test', 't')).toThrow('libsql://, https://')
    expect(() => resolveHttpUrl('https://u:p@db.example.test', 't')).toThrow('credenciais')
    expect(() => resolveHttpUrl('', 't')).toThrow('ausente ou inválida')
  })
})

describe('valores', () => {
  it('ida e volta de inteiro grande, blob, float e null', () => {
    expect(toHrana(9007199254740993n)).toEqual({ type: 'integer', value: '9007199254740993' })
    expect(fromHrana({ type: 'integer', value: '9007199254740993' })).toBe(9007199254740993n)
    expect(fromHrana({ type: 'integer', value: '42' })).toBe(42)
    expect(toHrana(1.5)).toEqual({ type: 'float', value: 1.5 })
    expect(fromHrana(toHrana(new Uint8Array([0, 255, 7])) as never)).toEqual(new Uint8Array([0, 255, 7]))
    expect(toHrana(null)).toEqual({ type: 'null' })
    expect(() => toHrana(Number.NaN)).toThrow('número inválido')
  })
})

describe('http (fetch falso)', () => {
  it('manda o token só no cabeçalho e nunca o mostra em erro', async () => {
    const { doFetch, calls } = fakeFetch(() => new Response('nope', { status: 401 }))
    const driver = http({ url: 'libsql://db.example.test', authToken: TOKEN, fetch: doFetch })
    const error = await driver.query({ sql: 'SELECT 1' }).catch((e: Error) => e)
    expect(String(error)).toContain('recusou o acesso (HTTP 401)')
    expect(String(error)).not.toContain(TOKEN)
    expect(calls[0]!.url).toBe('https://db.example.test/v2/pipeline')
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.stringify(calls[0]!.body)).not.toContain(TOKEN)
  })

  it('rede fora, tempo esgotado, HTTP 500 e resposta torta viram erros claros', async () => {
    const down = http({ url: 'http://127.0.0.1:1', fetch: (async () => Promise.reject(new TypeError('econnrefused'))) as unknown as typeof fetch })
    await expect(down.query({ sql: 'SELECT 1' })).rejects.toThrow('banco inacessível')
    const slow = http({
      url: 'http://127.0.0.1:1',
      fetch: (async () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))) as unknown as typeof fetch,
      timeoutMs: 5,
    })
    await expect(slow.query({ sql: 'SELECT 1' })).rejects.toThrow('não respondeu em 5 ms')
    const broken = http({ url: 'http://127.0.0.1:1', fetch: fakeFetch(() => new Response('x', { status: 500 })).doFetch })
    await expect(broken.query({ sql: 'SELECT 1' })).rejects.toThrow('HTTP 500')
    const short = http({ url: 'http://127.0.0.1:1', fetch: fakeFetch(() => Response.json({ results: [] })).doFetch })
    await expect(short.query({ sql: 'SELECT 1' })).rejects.toThrow('incompleta')
    const notJson = http({ url: 'http://127.0.0.1:1', fetch: fakeFetch(() => new Response('<html>')).doFetch })
    await expect(notJson.query({ sql: 'SELECT 1' })).rejects.toThrow('não é JSON')
  })

  it('transação sem FK: PRAGMA é o primeiro passo e o BEGIN depende dele', async () => {
    const { doFetch, calls } = fakeFetch((body) =>
      Response.json({
        results: body.requests.map(() => ({ type: 'ok', response: { type: 'batch', result: { step_results: [{}, {}, {}, {}, null, {}], step_errors: [null, null, null, null, null, null] } } })),
      }),
    )
    await http({ url: 'http://127.0.0.1:1', fetch: doFetch }).transaction([{ sql: 'CREATE TABLE a (x)' }], { foreignKeys: false })
    const steps = (calls[0]!.body.requests[0] as { batch: { steps: { stmt: { sql: string }; condition?: unknown }[] } }).batch.steps
    expect(steps.map((step) => step.stmt.sql)).toEqual(['PRAGMA foreign_keys = OFF', 'BEGIN IMMEDIATE', 'CREATE TABLE a (x)', 'COMMIT', 'ROLLBACK', 'PRAGMA foreign_keys = ON'])
    expect(steps[1]!.condition).toEqual({ type: 'ok', step: 0 })
    expect(steps[5]!.condition).toBeUndefined()
  })
})

describe('http (sqld de verdade)', () => {
  it('lê, escreve, desfaz transação com erro e devolve tipos certos', async () => {
    const driver = http({ url: await startSqld() })
    await driver.run({ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, big INTEGER, data BLOB, note TEXT, ratio REAL)' })
    expect(
      await driver.run({ sql: 'INSERT INTO t (big, data, note, ratio) VALUES (?, ?, ?, ?)', args: [9007199254740993n, new Uint8Array([1, 2]), "a'b;c", 0.25] }),
    ).toEqual({ changes: 1 })
    expect(await driver.query({ sql: 'SELECT big, data, note, ratio FROM t' })).toEqual([
      { big: 9007199254740993n, data: new Uint8Array([1, 2]), note: "a'b;c", ratio: 0.25 },
    ])
    await expect(
      driver.transaction([{ sql: "INSERT INTO t (note) VALUES ('fica?')" }, { sql: 'INSERT INTO nao_existe VALUES (1)' }], { foreignKeys: true }),
    ).rejects.toThrow('nao_existe')
    expect(await driver.query({ sql: "SELECT count(*) AS n FROM t WHERE note = 'fica?'" })).toEqual([{ n: 0 }])
    await driver.transaction([], { foreignKeys: true })
  })
})
