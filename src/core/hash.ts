// Hashes do histórico e impressão digital do schema. Só Web Crypto: roda em Bun,
// Node e Cloudflare Workers sem `node:crypto`.
import type { SchemaShape } from './types'

const encoder = new TextEncoder()

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Conteúdo que o checksum cobre: sem BOM e com fim de linha `\n`. O mesmo
 * arquivo num checkout do Windows (`core.autocrlf`) não vira "migration editada".
 */
export function canonicalContent(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** Checksum de uma migration: SHA-256 do conteúdo canônico. */
export const checksumOf = (content: string) => sha256(canonicalContent(content))

/** Cada elo cobre o anterior: inserir, remover ou reordenar quebra a cadeia. */
export function chainHash(previous: string, name: string, checksum: string): Promise<string> {
  return sha256(`${previous}\n${name}\n${checksum}`)
}

/**
 * Impressão digital estável, com a mesma semântica de `diffSchemas`: as
 * propriedades são comparadas como conjuntos, então a ordem física não importa.
 */
export function schemaHash(shape: SchemaShape): Promise<string> {
  const ordered = Object.keys(shape)
    .sort()
    .map((name) => {
      const table = shape[name]!
      return [name, [...table.columns].sort(), [...table.foreignKeys].sort(), [...table.indexes].sort(), [...table.checks].sort()]
    })
  return sha256(JSON.stringify(ordered))
}

/** Diferenças legíveis; lista vazia quer dizer schemas equivalentes. */
export function diffSchemas(expected: SchemaShape, actual: SchemaShape): string[] {
  const differences: string[] = []
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const name of [...names].sort()) {
    const left = expected[name]
    const right = actual[name]
    if (!left) {
      differences.push(`tabela inesperada ${name}`)
      continue
    }
    if (!right) {
      differences.push(`tabela faltando ${name}`)
      continue
    }
    for (const key of ['columns', 'foreignKeys', 'indexes', 'checks'] as const) {
      for (const item of left[key].filter((value) => !right[key].includes(value))) differences.push(`${name} ${key} faltando: ${item}`)
      for (const item of right[key].filter((value) => !left[key].includes(value))) differences.push(`${name} ${key} inesperado: ${item}`)
    }
  }
  return differences
}
