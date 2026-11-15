# API

O Worker `formacao-fde-solucao-case-api`, na Cloudflare. Por enquanto, responde
`GET /health`, `GET /me` e `GET /api/valor-barrado` e a tela de `web/` (atrás do Cloudflare Access, #60; o
painel está em `src/panel/README.md`) e tem um Cron a cada 15 minutos que só
registra que rodou.

## Rodar local

```bash
npm ci
npm run dev
```

Os segredos ficam no `api/.dev.vars`, que o git ignora, um por linha:

```
BARTE_ACADEMY_SUPABASE_SECRET_KEY=...
ACCESS_AUD=...
ACCESS_TEAM_DOMAIN=barte-academy.cloudflareaccess.com
```

## Testar

```bash
npm run typecheck
npm test
```

Na raiz do repositório, `make check` roda os dois junto com o resto do gate.

## Publicar

Não se publica à mão. Cada merge na `main` que mexe em `api/` roda o workflow
`.github/workflows/deploy-api.yml`, que testa e publica com `wrangler deploy`.
Ele também pode ser disparado pela aba Actions, mas só publica a partir da `main`. Os segredos do Worker em
produção entram com `npx wrangler secret put <NOME>`, nunca no git.

## Listas paginadas por cursor (#159)

As quatro listas das telas (`GET /api/fila`, `GET /api/hoje`, `GET /api/duplicates` e `GET /api/doca`,
mais `GET /api/recebimento-loja`, que é o mesmo handler da doca) paginam por cursor. O código está em
`src/http/page.ts`.

**Dois modos.** Sem `cursor` e sem `limite` na query, cada rota responde como antes da #159: a lista
inteira, na forma antiga (a tela de duplicadas e as demais ainda leem assim). Com `cursor` ou `limite`,
entra o modo paginado, que é o contrato novo.

**Query.**

| Parâmetro | Vale | Quando falha |
|---|---|---|
| `limite` | inteiro de 25 a 50; ausente (com `cursor`) é 30 | 400 `{ "error": "limite_invalido" }` |
| `cursor` | o `nextCursor` da página anterior, como veio; ausente é a primeira página | 400 `{ "error": "cursor_invalido" }` |

Por que 30: é o meio da faixa. Enche uma tela de tabela com folga, para o scroll infinito pedir a
próxima página antes de a pessoa chegar ao fim, e a resposta cabe no Worker sem custo. O 400 traz só o
código: nunca o valor recebido nem a causa. Os demais parâmetros de cada rota (`dia`, `destino`, `data`,
`loja`) continuam valendo e devem ir iguais em todas as páginas.

**Resposta paginada.** `items` é a página, `nextCursor` é o cursor da próxima (`null` na última),
`total` é a quantidade da lista inteira (a mesma em todas as páginas) e `aggregates` traz o que a tela
mostra no topo, calculado sobre a lista inteira: não muda com a página pedida. Dinheiro é `{ cents, text }`.
Mais os campos de contexto da lista.

| Lista | Contexto | `aggregates` | Os itens |
|---|---|---|---|
| `/api/fila` | `approver` | `approvable` (quantas a pessoa pode aprovar), `amountAtRisk` (soma do valor em risco), `blocked` (quantas no nível `bloqueio`) | os de antes, em `items` |
| `/api/hoje` | `day` | `toPay` (a soma "A pagar"), `approvedByRule` (quantas aprovadas pela regra) | os de antes, em `items` |
| `/api/duplicates` | nenhum | `blockedAmount` (soma do valor barrado), `byReason` (`titulo_lancado` e `ordem_sem_saldo`) | as entradas de `duplicates`, em `items` |
| `/api/doca` | `destination`, `date`, `destinations` | `awaiting` (aguardando aprovação no destino inteiro) | as `rows`, em `items` |

Atenção a `total` na lista do dia: sem cursor continua `{ "cents": ... }` (a soma); com cursor é a
contagem, e a soma passou para `aggregates.toPay`. Na doca, `rows` vira `items`, e `awaiting` sai do topo
e vai para `aggregates`.

**Ordem.** Cada lista tem uma ordem total, a mesma nos dois modos: fila, o nível mais severo primeiro
(`APPROVAL_LEVELS`), depois o maior valor em risco, depois a chave de acesso; hoje e duplicadas, a chave
de acesso da nota; doca, o número da nota (como número) e a chave de acesso.

**Cursor.** É opaco: base64url de um JSON versionado com a tupla de ordenação do último item entregue e o
nome da lista. A próxima página são os itens estritamente depois dessa tupla, e não uma posição: um item
decidido entre duas páginas não faz outro pular nem repetir. O cursor de uma lista não serve noutra. Quem
consome trata o cursor como texto e não o monta.

## Cloudflare Access

Toda rota, menos `GET /health`, exige o JWT do Cloudflare Access (#54). O Worker lê o token do
cabeçalho `Cf-Access-Jwt-Assertion` ou do cookie `CF_Authorization` e confere a assinatura RS256
contra as chaves do time, o `aud`, o `iss` e a validade. `GET /me` devolve o e-mail de quem entrou.

| Situação | Resposta |
|---|---|
| Sem token (mesmo com as variáveis vazias) | 401 `unauthenticated` |
| Com token, mas `ACCESS_AUD` ou `ACCESS_TEAM_DOMAIN` vazios | 503 `access_not_configured` |
| Token inválido (assinatura, `aud`, `iss`, expirado, kid desconhecido) | 403 `forbidden` |
| Chaves do time fora do ar | 503 `access_unavailable` |

As duas variáveis não são segredo. Em produção, a esteira passa com `wrangler deploy --var`, a
partir das variáveis do repositório `BARTE_ACADEMY_ACCESS_AUD` e `BARTE_ACADEMY_ACCESS_TEAM_DOMAIN`.
Localmente, ficam no `.dev.vars`; sem elas, só o `/health` responde 200.

### Provisionar

Uma vez por conta, no painel da Cloudflare: abra o Zero Trust, crie o time `barte-academy` e
escolha o plano Free. Depois, na raiz do repositório:

```bash
export BARTE_ACADEMY_CLOUDFLARE_API_TOKEN=...   # com permissão de Access: Apps and Policies
export BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID=...
export BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS="aluno1@gmail.com, aluno2@gmail.com"
python3 scripts/cloudflare_access.py --dry-run   # mostra o que enviaria
python3 scripts/cloudflare_access.py
```

O script garante o login por código no e-mail e a aplicação `formacao-fde-solucao-case`, com a
política que libera a `barte.com` e os alunos listados. Rodar de novo atualiza, não duplica. No fim,
imprime `ACCESS_AUD=...` e `ACCESS_TEAM_DOMAIN=...`: são os valores das variáveis do repositório.
