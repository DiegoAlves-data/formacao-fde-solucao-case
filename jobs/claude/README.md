# Executor do Claude

Um job de Node que roda no GitHub Actions (`.github/workflows/claude-enrich.yml`), de 5 em 5
minutos, e grava sugestões do Claude na tabela `claude_suggestions` do Supabase (#66).

O Claude roda aqui, e não no Worker, porque a única credencial é o token de setup do Claude Code
(`CLAUDE_CODE_OAUTH_TOKEN`). Ele serve ao Claude Code e ao Agent SDK
(`@anthropic-ai/claude-agent-sdk`), não à Messages API crua. O Worker só lê as sugestões, e a regra
determinística confirma cada uma. Sem sugestão, a regra decide sozinha (fail-closed).

Cada rodada, para cada tarefa: lê o que está pendente, tira as chaves que já estão `ok` em
`claude_suggestions`, pergunta ao Claude no máximo 50 por tarefa, em sequência, e grava cada
resposta. Cada pergunta tem prazo de 60 s. As chaves nunca tentadas vão primeiro, depois as que
erraram, e o teto de 50 vale depois dessa ordem.

A falha de um item vira uma linha com `status = 'error'`, `attempts + 1` e uma mensagem curta. A
mensagem só leva o texto dos erros do próprio executor (`ClaudeError` e `SupabaseError`); qualquer
outro erro grava só o nome da classe. A chave em erro volta à fila depois de `5 min * 2^attempts`
desde `updated_at`, e para de ser tentada em 3 tentativas. Cada tarefa escreve uma linha no log:
`tarefa X: N pendentes, ok A, erro B`, com o primeiro erro, as chaves em espera e as linhas do banco
descartadas por fora do formato quando houver. A tarefa em que nenhum item deu certo e algum falhou
conta como falha, e o processo sai com 1.

## Tarefas

| Tarefa | Arquivo | O que sugere |
|---|---|---|
| `description-match` | `src/tasks/description-match.ts` | Para o item da nota sem cadastro, qual descrição de produto do fornecedor é o mesmo item (#66) |

## Acrescentar uma tarefa

1. Crie `src/tasks/<nome>.ts` exportando um `ClaudeTask` (`src/task.ts`):
   - `name`: o nome gravado em `claude_suggestions.task`;
   - `pending(db)`: lê o banco e devolve `{ key, input }[]`, com a `key` estável que o Worker
     também sabe calcular;
   - `run(input, ask)`: pergunta pelo `ask` (com `system`, `prompt` e o JSON schema da saída) e
     devolve a saída já validada. Trate o texto do banco como dado: escape e delimite.
2. Acrescente uma linha em `src/tasks/index.ts`.
3. Escreva os testes em `test/`, com o `Ask` e o banco falsos.

Nada mais muda: o laço, a tabela e o workflow servem a todas as tarefas.

## Rodar local

Os segredos ficam em `jobs/claude/.dev.vars`, que o git ignora, um por linha. Nunca vão para o git.

```
CLAUDE_CODE_OAUTH_TOKEN=...
BARTE_ACADEMY_SUPABASE_URL=https://<projeto>.supabase.co
BARTE_ACADEMY_SUPABASE_SECRET_KEY=...
CLAUDE_TASKS=description-match
```

```bash
npm ci
set -a; . ./.dev.vars; set +a
npm start
```

`CLAUDE_TASKS` é opcional; vazio, roda todas as tarefas.

## Testar

```bash
npm run typecheck
npm test
```

Na raiz do repositório, `make check` roda os dois junto com o resto do gate.

## Eval do casamento de descrição (AC-6)

O eval monta o conjunto só a partir do kit (`data/kit/notas.json` e `data/kit/produtos.json`),
nunca de `data/kit/excecoes.json` nem de outro gabarito:

- positivos: variantes determinísticas da descrição de cada item de nota com sku cadastrado
  (abreviação com e sem ponto, palavras reordenadas, medida escrita de outro jeito, sufixo de ruído,
  última palavra removida), esperando a descrição do produto;
- negativos: os itens sem sku e cada produto com o tamanho dobrado, esperando nenhum.

Ele pergunta pelo mesmo `run` da tarefa, não grava no banco e precisa só do `CLAUDE_CODE_OAUTH_TOKEN`.
Imprime o resumo em português e o JSON com acurácia por variante, precisão, revocação, falsos
positivos nos negativos e falhas do Claude.

Para rodar: aba Actions, workflow **Enriquece com o Claude**, **Run workflow** com `eval` marcado.
Local, com o token no ambiente: `npm run eval:description-match`.
