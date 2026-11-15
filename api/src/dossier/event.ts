// #38 O dossiê disparado pelo evento: a proposta que acabou de virar `aguardando_aprovacao` nesta mesma
// rodada do tick (approval/propose-checked.ts). Quem chama agenda esta promise fora da resposta do Cron
// (defer/waitUntil, cron/tick.ts) — aqui não há rodada agendada relendo o estado da tabela (AC-1): o disparo
// nasce junto com o evento, uma vez só por proposta.
import { ClaudeError, DEFAULT_MODEL, type Ask } from '../claude/client.js';
import type { Db } from '../claude/db.js';
import { storedError } from '../claude/runner.js';
import { dossierRequest, failureReason, parseDossierOutput, type DossierInput } from '../claude/tasks/dossier.js';
import type { CheckContext, InvoiceView } from '../domain/index.js';
import { DOSSIER_TASK } from './source.js';

const TABLE = 'claude_suggestions';

/** #38 O que o disparo do evento precisa; tudo injetável nos testes. */
export type EventDossierDeps = {
  /** #38 O banco das sugestões, o mesmo Db do laço (#66) e do pedido sob demanda (#130). */
  readonly db: Db;
  /** #38 O contexto da nota, como a gaveta e o pedido sob demanda montam (#68). */
  readonly context: (invoiceAccessKey: string) => Promise<CheckContext>;
  /** #38 AC-5: sem credencial do Claude no Worker, undefined — a geração fecha em erro `claude_failed`. */
  readonly ask?: Ask;
  /** #38 Valores que nunca podem aparecer na coluna error nem no log (o token, a chave do Supabase). */
  readonly secrets?: readonly string[];
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
};

/** #38 Uma linha de claude_suggestions já existe para a chave, de qualquer origem: evento anterior (AC-6), ou um
 * pedido na gaveta (#130) que chegou primeiro. */
async function hasRow(db: Db, invoiceAccessKey: string): Promise<boolean> {
  const rows = await db.select(TABLE, {
    select: 'input_key',
    order: 'input_key.asc',
    filters: { task: `eq.${DOSSIER_TASK}`, input_key: `eq.${invoiceAccessKey}` },
  });
  return rows.length > 0;
}

/**
 * #38 AC-1: dispara sozinho para a proposta que acabou de passar a esperar uma pessoa — sem rodada agendada,
 * sem relação com o executor do laço de tarefas (#66/#171), que serve outras tarefas. AC-6: se já existe uma
 * linha para a chave, não chama o Claude de novo (a reivindicação final ainda é o `insert` com `ignore`, contra
 * uma corrida entre dois disparos). AC-2: a saída fora do schema vira erro de formato. AC-5: qualquer falha ou
 * prazo vencido grava `unavailable` com o motivo e nunca lança para fora — a fila do Cron nunca trava por isto.
 * AC-4: a linha não tem ação na doca, nível nem valor em risco; quem confere os números é a gaveta (readDossier).
 */
export async function generateOnEvent(deps: EventDossierDeps, invoice: InvoiceView): Promise<void> {
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.error(line));
  const key = invoice.accessKey;
  try {
    if (await hasRow(deps.db, key)) return; // AC-6: já há uma linha (evento anterior ou pedido na gaveta).

    const started = clock().getTime();
    let input: DossierInput | Record<string, never> = {};
    let result: { ok: true; output: unknown } | { ok: false; error: unknown };
    try {
      if (!deps.ask) throw new ClaudeError('auth', 'sem credencial do Claude no Worker');
      input = dossierRequest(invoice, await deps.context(key));
      const output = parseDossierOutput(await deps.ask<unknown>(input));
      if (!output) throw new ClaudeError('format', 'dossier: resposta do Claude fora do formato');
      result = { ok: true, output };
    } catch (error) {
      result = { ok: false, error };
    }
    const latencyMs = clock().getTime() - started;
    const fields = result.ok
      ? { output: result.output, status: 'ok', error: null, reason: null, attempts: 0 }
      : {
          output: null,
          status: 'error',
          error: storedError(result.error, deps.secrets),
          reason: failureReason(result.error),
          attempts: 1,
        };
    await deps.db.upsert(
      TABLE,
      [
        {
          task: DOSSIER_TASK,
          input_key: key,
          input,
          model: DEFAULT_MODEL,
          updated_at: clock().toISOString(),
          trigger: 'event',
          latency_ms: latencyMs,
          ...fields,
        },
      ],
      // #38 AC-6: a reivindicação de verdade. Se uma corrida já escreveu a linha entre o `hasRow` e aqui, o
      // `insert ... on conflict do nothing` do Postgres descarta esta escrita; não sobrescreve nada.
      { onConflict: 'task,input_key', resolution: 'ignore' },
    );
  } catch (error) {
    log(`#38 dossiê do evento da nota ${key} não gravado: ${storedError(error, deps.secrets)}`);
  }
}
