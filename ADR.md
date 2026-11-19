# ADR: migrator

Registro das decisões técnicas. Cada decisão diz o que foi escolhido, por quê e o que foi descartado.

Referências: o sistema de migrations do Drizzle (drizzle-kit 0.31 e a estrutura v1 em beta), o do Prisma (`migrate dev`/`migrate deploy`, `_prisma_migrations`, shadow database) e um executor anterior cujas proteções foram provadas no Turso Cloud.

---

## M1: Três peças separadas (layout, dialeto e driver)

**Decisão.** O núcleo não lê arquivo nem fala com banco. Recebe:

| Peça | Responsabilidade | Hoje |
|---|---|---|
| **Layout** | Encontrar as migrations, a ordem e os arquivos faltando | `sqlFolder`, `drizzleKitJournal`, `inlineLayout` |
| **Dialeto** | Todo SQL próprio do motor: tabelas técnicas, guardas, lint, leitura do schema | `sqlite` |
| **Driver** | Rodar comandos e transações numa conexão | `http`, `libsql`, `bunSqlite`, `d1` |

**Por quê.** Cada eixo muda por um motivo diferente: o formato de pasta do Drizzle está mudando; um banco novo muda o SQL; um SDK novo muda só a conexão. Cada mudança é um arquivo novo, sem tocar no núcleo.

O driver informa o dialeto padrão (`driver.dialect`): a configuração comum tem só `driver` e `layout`.

**Descartado.** Um executor por banco: duplicava as regras de segurança a cada motor.

## M2: Gerar não é daqui; aplicar é

O SQL vem de um gerador (drizzle-kit) ou é escrito à mão, revisado e versionado. Este pacote só lê e aplica, nunca gera nem regenera. Produção aplica exatamente o que foi revisado.

## M3: Formato de pasta como peça (`Layout`)

O layout devolve **problemas** (bloqueiam) e **avisos** (não bloqueiam).

| Situação | Tipo |
|---|---|
| Arquivo listado e ausente; ordem quebrada; nome ou número repetido | problema |
| Arquivo fora do padrão de nome, ou `.sql` fora do journal | aviso: fica de fora |

- `drizzleKitJournal`: `0000_nome.sql` e `meta/_journal.json`; o journal é a única fonte da ordem. Separa comandos só por `--> statement-breakpoint`.
- `sqlFolder`: `<número>_<nome>.sql`; a ordem é a do número. Separa nos `;` de nível superior (M15), ou pela fronteira do drizzle se o arquivo a tiver.
- `inlineLayout`: lista no código, para Workers e bundlers, onde não há pasta.

O formato v1 do Drizzle (pasta por migration, sem journal) entra como outro layout. O núcleo já identifica migrations pelo nome completo.

## M4: Tabela de histórico configurável, padrão `__migrations`

`table` define o nome do histórico; `<table>_lock` e `<table>_meta` derivam dele. Os nomes são validados como identificadores simples.

| Coluna | Uso |
|---|---|
| `id` | Ordem real de aplicação |
| `name` | Nome completo da migration, único |
| `checksum` | SHA-256 do conteúdo canônico (M16) |
| `chain` | Hash encadeado (M5) |
| `schema_hash` | Impressão do schema esperado depois desta migration (M8) |
| `applied_at` | Início da aplicação, ISO UTC |
| `applied_by` | Quem aplicou (informado por quem chama) |
| `app_commit` | Commit do código que aplicou |
| `tool_version` | Versão deste pacote |

`<table>_meta` guarda `identity`, `dialect` e `format` (versão das tabelas técnicas, para evoluir sem adivinhação).

**Descartado.** `duration_ms`: o registro é gravado na mesma transação da migration (M6), antes de saber a duração. A duração aparece no resultado de `migrate()`.

## M5: Checksum por arquivo e hash encadeado

`checksum = sha256(conteúdo canônico)`. `chain(n) = sha256(chain(n-1) + nome + checksum)`, com `chain(-1)` vazio. O checksum pega a edição de uma migration aplicada; a cadeia pega também inserir, remover ou reordenar no meio, e linha do histórico alterada à mão.

## M6: Uma transação por migration, com o registro dentro

Guarda da trava → comandos → guarda das chaves estrangeiras → linha do histórico. Tudo confirma junto ou nada confirma. As chaves estrangeiras ficam desligadas só dentro dessa transação: reconstruir uma tabela pai não apaga os filhos `ON DELETE CASCADE`.

Se a conexão cair, o núcleo consulta o histórico antes de decidir: nunca reaplica DDL às cegas.

**Por quê.** Provado no Turso Cloud: `PRAGMA defer_foreign_keys` não protege reconstrução de tabela; desligar as FKs só na transação, com `pragma_foreign_key_check` antes do commit, protege.

## M7: Trava em tabela, tomada antes de ler o histórico, liberação manual

`<table>_lock` com uma linha (`id = 1`), tomada por `INSERT`. Ocupada → aborta mostrando dono e horário. Cada transação revalida que a trava ainda é do mesmo dono. Trava abandonada só sai com `unlock(dono)`.

`migrate()` e `adopt()` tomam a trava **antes** de ler o histórico (M17).

**Descartado.** `pg_advisory_lock`/`GET_LOCK`: não existem no SQLite. Expiração automática da trava: um processo lento a perderia no meio e outro aplicaria em paralelo.

## M8: Drift: impressão digital do schema

O dialeto descreve o schema real (colunas, tipos, nulidade, defaults, chaves, ações das FKs, índices com predicados, CHECKs), ignorando formatação e tabelas técnicas. O núcleo reaplica o histórico num banco descartável do mesmo motor e compara:

- `status()` compara o banco com o histórico aplicado. Diferença bloqueia.
- `migrate()` grava em `schema_hash` a impressão esperada depois de cada migration e, depois do commit, confere o banco real. Diferença para as seguintes.

**Por quê.** É o shadow database do Prisma, mas em todos os ambientes, inclusive produção. O banco descartável não precisa de servidor: memória ou arquivo temporário.

## M9: Lint antes de aplicar: proibido e destrutivo

- **Proibido** (bloqueia sempre): dois comandos num item, controle de transação, `PRAGMA`, `VACUUM`, `ATTACH`, `DETACH`, `REINDEX`, item vazio.
- **Destrutivo** (bloqueia por padrão): `DROP TABLE`, `DROP VIEW`, `ALTER TABLE ... DROP`, `ALTER TABLE ... RENAME`, `DELETE`/`UPDATE` sem `WHERE`. Só passa com `-- migration:destructive <motivo>` no arquivo **e** `allowDestructive`.

Duas confirmações independentes: quem escreveu e quem aplica. O motivo fica no arquivo, revisado no PR.

O lint lê o texto sem comentários e sem strings (M18).

**Limite conhecido.** Um `WHERE` dentro de uma subconsulta faz um `UPDATE` sem `WHERE` próprio passar. O lint é uma rede, não um parser.

**Descartado.** Exigir expand/contract pela ferramenta: exigiria entender o código da aplicação. A regra fica como prática: remover leva duas versões, a segunda destrutiva.

## M10: Identidade do banco e promoção entre ambientes

`init()` grava `identity`. Todo comando confere a identidade antes de escrever e recusa banco de outro ambiente. `promotion: { from, applied }` aplica só migrations que já estão no histórico de outro ambiente.

`init()` recusa adotar um banco com tabelas e sem histórico; para isso existe `adopt()`.

## M11: Válvula de escape: `adopt()`

Registra migrations como aplicadas **sem rodar**, mas só se o schema real for idêntico ao produzido por elas (M8). É o `migrate resolve --applied` do Prisma, com verificação.

## M12: Sem reset e sem "down"

O pacote não apaga banco nem desfaz migration. Corrigir é criar outra (forward-only).

**Descartado.** Reset automático do Prisma em `migrate dev`: perigoso se o alvo estiver errado; o ganho é pequeno.

## M13: Fora do pacote

| Ideia | Onde fica |
|---|---|
| Backfill de dados grandes | Trabalho da aplicação, em lotes e retomável; migration só com mudança rápida de schema |
| Timeout de lock (`lock_timeout`) | Não existe no SQLite; o driver define o timeout de rede |
| Grafo de comutatividade entre branches | Só com layout sem ordem linear; hoje migration fora de ordem já bloqueia |
| Gerar SQL | M2 |

## M14: Dependências mínimas

Zero dependência em tempo de execução. Cada driver importa o próprio SDK como dependência opcional, por um caminho separado (`migrator/drivers/libsql`): quem usa um não carrega o outro.

---

Decisões desta biblioteca (revisão do executor anterior, 19/11/2026):

## M15: Separar comandos lendo o SQL, não com `split(";")`

`splitStatements` quebra o texto em tokens (strings, identificadores entre aspas, comentários) e só corta nos `;` de nível superior. O corpo de `CREATE TRIGGER ... BEGIN ... END` fica inteiro, mesmo com `CASE ... END` dentro.

**Por quê.** Pasta de `.sql` escritos à mão (o caso mais comum fora do drizzle) tem `;` dentro de string, comentário e trigger.

## M16: Checksum do conteúdo canônico

Antes do SHA-256, tira o BOM e troca CRLF/CR por LF. Um checkout no Windows (`core.autocrlf`) não vira "migration editada". Arquivos que já eram LF têm o mesmo checksum de antes.

## M17: Trava antes da leitura do histórico

**Problema encontrado.** O executor anterior lia o histórico e só depois tomava a trava. Duas execuções: B lê o histórico; A toma a trava, aplica e devolve; B toma a trava e aplica a lista velha. A segunda aplicação falhava por sorte (tabela já existe ou nome único no histórico), com uma mensagem enganosa, e um comando idempotente (`CREATE TABLE IF NOT EXISTS`) passaria.

**Decisão.** `migrate()` confere inicialização e identidade (só leitura), toma a trava e só então lê o histórico. `adopt()` também toma a trava. Teste: `quem toma a trava depois que outro terminou lê o histórico de novo`.

## M18: Lint sobre o texto sem comentários e sem strings

**Problema encontrado.** O lint anterior procurava `^\s*DROP TABLE` no texto cru. Um comentário antes (`-- limpeza\nDROP TABLE x`), comum em `.sql` escritos à mão, escondia o comando destrutivo, e um `PRAGMA` também. `WITH ... DELETE FROM` passava, e um `'WHERE'` dentro de string valia como `WHERE`.

**Decisão.** `stripSql` troca comentários por espaço, strings por `''` e identificadores entre aspas por `"_"`, e põe tudo em maiúsculas. O lint procura palavras-chave aí. Corpo de trigger não conta como alteração de dados agora.

## M19: Trava que não volta não esconde o erro

**Problema encontrado.** A liberação da trava ficava num `finally`: se ela falhasse (conexão caiu), o erro dela substituía o erro real da migration, e ninguém sabia qual dono passar ao `unlock`.

**Decisão.** Erro do trabalho + falha ao devolver: o erro do trabalho sobe, com o dono para o `unlock` acrescentado. Trabalho certo + falha ao devolver: erro que diz que o trabalho está no histórico e mostra o dono.

## M20: Núcleo sem Node nem Bun; banco descartável como peça

**Decisão.** O núcleo usa Web Crypto (`crypto.subtle`, `crypto.randomUUID`), não `node:crypto`: `migrator` importa em Workers. `Driver.scratch` virou opcional e pode vir da configuração (`MigratorConfig.scratch`). `drivers/d1` deixou de importar `bun:sqlite`; o banco descartável dele vem de fora (`memoryScratch` nas ferramentas).

## M21: Driver HTTP sem SDK

**Decisão.** `drivers/http` fala Hrana v2 (`/v2/pipeline`) só com `fetch`: Turso Cloud e `sqld`, sem `@libsql/client`. Cada chamada é um pipeline fechado. A transação sem FKs é **um lote só**: `PRAGMA foreign_keys = OFF`, `BEGIN` (só se o PRAGMA deu certo), comandos encadeados, `COMMIT` (só se todos deram certo), `ROLLBACK`, `PRAGMA foreign_keys = ON` (sempre).

**Por quê o lote só.** Com o PRAGMA num pedido separado, uma falha nele deixaria a transação rodar com as FKs ligadas, e uma reconstrução de tabela pai apagaria os filhos em cascata. O teste com 500 pessoas falsas no `sqld` de verdade falha se as FKs ficarem ligadas.

Inteiro fora da faixa segura volta como `bigint`; blob, como `Uint8Array`. O token nunca entra em mensagem de erro. `http://` só em loopback.
