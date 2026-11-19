# AGENTS.md: guia para agentes que mexem no migrator

`migrator` aplica migrations SQL já escritas. Não gera SQL, não desfaz migration e não apaga banco.

## Leia primeiro (5 minutos)

| Arquivo | Para quê |
|---|---|
| `src/index.ts` | Tudo o que é público no núcleo. Não importe de `src/core/` fora daqui |
| `src/core/migrator.ts` | `init`, `status`, `migrate`, `adopt`, `unlock`: a trava, o histórico e as guardas |
| `src/core/types.ts` | Os contratos `Driver`, `Layout` e `Dialect` |
| `src/core/sql-text.ts` | Leitura de SQL sem se enganar com strings e comentários (`splitStatements`, `stripSql`) |
| `src/dialects/sqlite.ts` | Lint, tabelas técnicas e a descrição do schema do SQLite |
| `src/drivers/*` e `src/layouts/*` | As peças prontas |
| `SKILL.md` | Como usar a biblioteca num app (gera `llms.txt`) |
| `ADR.md` | Por que cada decisão, e o que foi descartado |
| `TAREFAS.md` | O que falta |
| `RELEASING.md` | Como publicar uma versão |

## Regras fixas

1. **Zero dependência em tempo de execução.** `@libsql/client` é dependência opcional só de `drivers/libsql`, carregada por tipo ou `import()`. Dependência nova exige pedido do dono.
2. **O núcleo roda em qualquer lugar.** `src/core/`, `src/index.ts` e `src/dialects/` não importam `node:*`, `bun:*` nem SDK: só Web Crypto. `drivers/http` e `drivers/d1` também (são os de Workers). `tests/project.test.ts` confere.
3. **Lógica separada da implementação.** Banco novo, SDK novo ou formato de pasta novo é um arquivo novo em `src/dialects/`, `src/drivers/` ou `src/layouts/`, sem mexer no núcleo. Se o núcleo precisar mudar para isso, o contrato em `types.ts` está errado: corrija o contrato.
4. **Falha fechada, nunca em silêncio.** Na dúvida, bloqueia com uma mensagem que diz o que aconteceu e o que fazer. Nada é reaplicado às cegas: depois de um erro, o histórico decide.
5. **Toda falha de segurança vira teste no mesmo commit.** Lint enganado, trava furada, checksum burlado: o teste que reproduz entra junto com a correção, e precisa falhar sem ela (confira quebrando a correção de propósito).
6. **Testes com dados falsos e determinísticos.** `fakePeople` e `seeded` em `tests/helpers.ts`; e-mails só em `example.test`. Nunca dados reais. Testes não dependem do relógio (`now` falso) nem rodam em segundo plano.
7. **A mesma bateria em todos os motores.** `tests/migrator.test.ts` roda em `bun:sqlite`, arquivo libSQL e HTTP contra um `sqld` de verdade. Comportamento novo do núcleo entra na bateria, não num motor só.
8. **Documentação junto com o código, numa fonte só.** Mudou a API pública: atualize `SKILL.md` e rode `bun run docs` no mesmo commit. Os blocos ```ts de `SKILL.md` e `README.md` passam pelos tipos e rodam no teste; bloco que precisa de servidor começa com `// exemplo: só tipos`.
9. **Código em inglês.** Identificadores, nomes de arquivo e exemplos em inglês. Comentários, documentação e mensagens de erro em português, com o prefixo `migrator:`.
10. **Nada privado no repositório.** Ele é público, inclusive o histórico: nome de projeto ou cliente, caminho de computador, e-mail pessoal e segredo ficam de fora. `bun run leak-check` confere arquivos, histórico e autores; as palavras privadas ficam em `.private-words` (fora do Git).
11. **O que a IA acrescenta precisa ser perguntado.** Sugerir é bem-vindo: diga o que foi acrescentado, separado do que o dono pediu, e pergunte. Regra, limite ou número criado pela IA não vira decisão sem resposta dele.

## Antes de terminar

```sh
mise install          # bun e sqld fixados
bun test              # inclui sqld de verdade, tipos e exemplos da documentação
bunx tsc --noEmit -p .
bun run leak-check
```

Depois teste num projeto que usa a biblioteca. Relate o que verificou e o que não verificou.

Mudança que vai para quem usa a biblioteca: siga [`RELEASING.md`](RELEASING.md). Nunca crie, mova ou apague tag à mão.
