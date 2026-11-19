// Leitura de texto SQL sem se enganar com strings, identificadores entre aspas ou
// comentários. Não é um parser: só separa o que é código do que é texto.

export type TokenKind = 'word' | 'semicolon' | 'string' | 'identifier' | 'comment' | 'space' | 'other'

export interface Token {
  kind: TokenKind
  text: string
  start: number
}

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y
const SPACE = /\s+/y

/** Quebra o texto em tokens. Comentário ou aspa sem fechamento vai até o fim do texto. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  const push = (kind: TokenKind, end: number) => {
    tokens.push({ kind, text: sql.slice(index, end), start: index })
    index = end
  }
  while (index < sql.length) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index)
      push('comment', end === -1 ? sql.length : end + 1)
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      push('comment', end === -1 ? sql.length : end + 2)
      continue
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char
      let end = index + 1
      while (end < sql.length) {
        if (sql[end] === close) {
          // Aspas dobradas são escape dentro de strings e identificadores.
          if (close !== ']' && sql[end + 1] === close) {
            end += 2
            continue
          }
          break
        }
        end += 1
      }
      push(char === "'" ? 'string' : 'identifier', Math.min(end + 1, sql.length))
      continue
    }
    if (char === ';') {
      push('semicolon', index + 1)
      continue
    }
    SPACE.lastIndex = index
    if (SPACE.test(sql)) {
      push('space', SPACE.lastIndex)
      continue
    }
    WORD.lastIndex = index
    if (WORD.test(sql)) {
      push('word', WORD.lastIndex)
      continue
    }
    push('other', index + 1)
  }
  return tokens
}

/**
 * Posição de cada `;` que encerra um comando e a primeira palavra do texto
 * (vazia quando só há espaço e comentários).
 */
export function scanSql(sql: string): { terminators: number[]; firstKeyword: string } {
  const tokens = tokenize(sql)
  return {
    terminators: tokens.filter((token) => token.kind === 'semicolon').map((token) => token.start),
    firstKeyword: tokens.find((token) => token.kind === 'word')?.text.toUpperCase() ?? '',
  }
}

/**
 * Só o código, em maiúsculas: comentários viram espaço, strings viram `''` e
 * identificadores entre aspas viram `"_"`. O lint procura palavras-chave aqui,
 * então nem um comentário antes do `DROP` nem um `'WHERE'` dentro de string o enganam.
 */
export function stripSql(sql: string): string {
  return tokenize(sql)
    .map((token) => {
      if (token.kind === 'comment') return ' '
      if (token.kind === 'string') return "''"
      if (token.kind === 'identifier') return '"_"'
      return token.kind === 'word' ? token.text.toUpperCase() : token.text
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Verdadeiro quando o texto tem mais de um comando. */
export function hasMultipleStatements(sql: string): boolean {
  return splitStatements(sql).length > 1
}

const TRIGGER_START = /^CREATE (TEMP |TEMPORARY )?TRIGGER\b/

/**
 * Separa comandos nos `;` de nível superior. O corpo de um `CREATE TRIGGER`
 * (`BEGIN ... END`) fica inteiro, mesmo com `CASE ... END` dentro. Trechos só
 * de comentário somem; o `;` final de cada comando sai.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current: Token[] = []
  let words: string[] = []
  let depth = 0
  let bodyOpened = false

  const flush = () => {
    const text = current
      .map((token) => token.text)
      .join('')
      .trim()
    if (current.some((token) => token.kind !== 'space' && token.kind !== 'comment')) statements.push(text)
    current = []
    words = []
    depth = 0
    bodyOpened = false
  }

  for (const token of tokenize(sql)) {
    if (token.kind === 'word') {
      const word = token.text.toUpperCase()
      if (words.length < 3) words.push(word)
      if (TRIGGER_START.test(words.join(' '))) {
        if (word === 'BEGIN' || word === 'CASE') {
          depth += 1
          if (word === 'BEGIN') bodyOpened = true
        } else if (word === 'END' && depth > 0) depth -= 1
      }
    }
    if (token.kind === 'semicolon') {
      const inTrigger = TRIGGER_START.test(words.join(' '))
      if (!inTrigger || (bodyOpened && depth === 0)) {
        flush()
        continue
      }
    }
    current.push(token)
  }
  flush()
  return statements
}
