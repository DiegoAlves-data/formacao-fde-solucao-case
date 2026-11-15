// #38: tarefa do Claude (#66, #171) que escreve o dossiê da proposta encaminhada a uma pessoa.
// #38 A tarefa não decide nem grava: o laço registra a saída em claude_suggestions, e a gaveta lê e confere
// cada número contra o banco na hora de mostrar (readDossier, #68). Ação, nível e valor em risco vêm da regra.
import { ClaudeError, type Ask } from '../client.js';
import type { Db } from '../db.js';
import { keyStates } from '../runner.js';
import type { ClaudeTask } from '../task.js';
import { SupabaseApprovalStore } from '../../approval/supabase-store.js';
import { supabaseConnectors } from '../../connectors/supabase-connectors.js';
import type { SupabaseRest } from '../../connectors/supabase-rest.js';
import { loadDossierContext } from '../../dossier/context.js';
import { IN_FLIGHT_MS, inFlight, SupabaseDossierRequests, type DossierRequests } from '../../dossier/requests.js';
import { buildDossierPrompt } from '../../dossier/prompt.js';
import { DOSSIER_TASK } from '../../dossier/source.js';
import { buildFactCatalog, DOSSIER_OUTPUT_SCHEMA, type CheckContext, type InvoiceView } from '../../domain/index.js';
import type { CaseFile } from '../../approval/store.js';

/** #38 O que a pergunta precisa, já serializado: o system, o prompt com os dados e o schema da saída. */
export type DossierInput = { system: string; prompt: string; schema: Record<string, unknown> };

/** #38 A saída crua do Claude, no formato de DOSSIER_OUTPUT_SCHEMA. Os números ainda não foram conferidos. */
export type DossierOutput = {
  summary: string;
  divergences: { classification: string; what_diverges: string; evidence: string[] }[];
  supplier_history: string;
};

/** #38 Fontes da tarefa, injetáveis nos testes. */
export type DossierTaskDeps = {
  /** As propostas que esperam uma pessoa, ainda sem aprovação. */
  readonly listAwaiting: () => Promise<readonly CaseFile[]>;
  /** O contexto da nota, como a gaveta monta (#68). */
  readonly loadContext: (invoiceAccessKey: string) => Promise<CheckContext>;
  /** Teto de pedidos montados por rodada; o padrão é o do Cron (CRON_LIMIT). */
  readonly limit?: number;
  /** Relógio da espera entre tentativas, o mesmo do laço. */
  readonly now?: () => Date;
  /** #130 Os pedidos da gaveta: a chave com um pedido em andamento fica para a geração sob demanda. */
  readonly requests?: DossierRequests;
};

/**
 * #38 O teto de pedidos que pending() monta por rodada. É o CRON_LIMIT de cron.ts, repetido aqui porque cron.ts
 * importa o registro das tarefas e a importação de volta faria um ciclo.
 */
export const DOSSIER_LIMIT = 5;

/** #38 AC-1: só a proposta que espera uma pessoa ganha dossiê. A regra aprova o resto sozinha. */
export function needsDossier(file: Pick<CaseFile, 'proposal' | 'route' | 'approval'>): boolean {
  return file.approval === null && file.proposal.state === 'aguardando_aprovacao' && file.route.level !== 'regra';
}

/** #38 Monta o pedido do dossiê de uma nota: o mesmo catálogo de fatos que a gaveta usa para conferir. */
export function dossierRequest(invoice: InvoiceView, ctx: CheckContext): DossierInput {
  const catalog = buildFactCatalog(invoice, ctx);
  const { system, prompt } = buildDossierPrompt(catalog, invoice.divergences);
  return { system, prompt, schema: DOSSIER_OUTPUT_SCHEMA as unknown as Record<string, unknown> };
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** #38 AC-2: a resposta fora do schema não é gravada como ok. O laço registra a linha de erro. */
export function parseDossierOutput(raw: unknown): DossierOutput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.summary) || !isStr(r.supplier_history) || !Array.isArray(r.divergences)) return null;
  const divergences: DossierOutput['divergences'] = [];
  for (const d of r.divergences) {
    if (typeof d !== 'object' || d === null) return null;
    const x = d as Record<string, unknown>;
    if (!isStr(x.classification) || !isStr(x.what_diverges) || !Array.isArray(x.evidence) || !x.evidence.every(isStr)) {
      return null;
    }
    divergences.push({ classification: x.classification, what_diverges: x.what_diverges, evidence: [...x.evidence] });
  }
  return { summary: r.summary, divergences, supplier_history: r.supplier_history };
}

/** #130 O motivo do erro na língua da gaveta: formato, prazo ou o resto (`claude_failed`). */
export type DossierFailureReason = 'claude_failed' | 'invalid_shape' | 'timeout';

/** #130 Do erro da chamada ao motivo gravado em claude_suggestions.reason. */
export function failureReason(error: unknown): DossierFailureReason {
  if (error instanceof ClaudeError && error.kind === 'format') return 'invalid_shape';
  if (error instanceof ClaudeError && error.kind === 'timeout') return 'timeout';
  return 'claude_failed';
}

/** #130 As chaves com pedido da gaveta em andamento (aberto há menos de IN_FLIGHT_MS). */
async function busyKeys(requests: DossierRequests, now: Date): Promise<Set<string>> {
  const open = await requests.openSince(new Date(now.getTime() - IN_FLIGHT_MS));
  const keys = new Set<string>();
  for (const r of open) if (inFlight([r], now)) keys.add(r.input_key);
  return keys;
}

/** #38 A tarefa sobre fontes injetadas; `dossierTask` liga ao Supabase. */
export function dossierTaskWith(deps: DossierTaskDeps): ClaudeTask<DossierInput, DossierOutput> {
  return {
    name: DOSSIER_TASK,

    /**
     * #38 AC-1 e AC-6: as propostas que esperam uma pessoa. A chave já ok, esgotada ou ainda na espera sai antes
     * do contexto (keyStates, a mesma regra do laço): sem nada novo, a rodada não lê as 7 tabelas nem chama o
     * Claude. Antes, o contexto era lido em toda rodada, e na rodada que estoura os subrequests a chamada ou o
     * upsert do erro falhava sem linha, e a chave voltava na rodada seguinte (AC-5, AC-6).
     */
    async pending(db: Db) {
      const awaiting = (await deps.listAwaiting()).filter(needsDossier);
      if (awaiting.length === 0) return { requests: [], dropped: 0 };
      const now = (deps.now ?? (() => new Date()))();
      const states = await keyStates(db, DOSSIER_TASK, now);
      // #38 As nunca tentadas primeiro, como na fila do laço; o teto vem depois, antes de ler o contexto.
      const fresh = awaiting.filter((f) => !states.has(f.invoice.accessKey));
      const retries = awaiting.filter((f) => states.get(f.invoice.accessKey) === 'retry');
      const candidates = [...fresh, ...retries];
      // #38 AC-6 e #130: a chave que a pessoa pediu na gaveta e ainda está em geração fica de fora, para o Cron
      // não chamar o Claude de novo e sobrescrever a linha. Uma leitura a mais, só quando há candidata.
      const busy = candidates.length > 0 && deps.requests ? await busyKeys(deps.requests, now) : new Set<string>();
      const files = candidates.filter((f) => !busy.has(f.invoice.accessKey)).slice(0, deps.limit ?? DOSSIER_LIMIT);
      if (files.length === 0) return { requests: [], dropped: 0 };
      // #38 Um contexto só para a rodada: o catálogo de cada nota usa as mesmas tabelas. A chave vazia não tira
      // nenhuma nota das capturadas; cada nota sai da própria lista logo abaixo.
      const shared = await deps.loadContext('');
      const requests = files.map((file) => {
        const key = file.invoice.accessKey;
        // #68 Regra 1: a própria nota não entra entre as capturadas.
        const ctx = { ...shared, capturedInvoices: shared.capturedInvoices.filter((i) => i.accessKey !== key) };
        return { key, input: dossierRequest(file.invoice, ctx) };
      });
      return { requests, dropped: 0 };
    },

    /** #38 AC-2: pergunta com a saída estruturada no schema do contrato e valida antes de devolver. */
    async run(input: DossierInput, ask: Ask): Promise<DossierOutput> {
      const output = parseDossierOutput(await ask<unknown>(input));
      // #38 ClaudeError leva a mensagem para a linha de erro; 'format' não é global, então só esta chave erra.
      if (!output) throw new ClaudeError('format', 'dossier: resposta do Claude fora do formato');
      return output;
    },

    /** #130 A linha do evento diz que veio do evento, quanto a chamada levou e, no erro, o motivo. */
    rowFields(outcome) {
      const reason = 'error' in outcome ? failureReason(outcome.error) : null;
      return { trigger: 'event', reason, latency_ms: outcome.latencyMs };
    },
  };
}

/** #38 A tarefa ligada ao Supabase, pelo mesmo REST que o Cron já tem. */
export const dossierTask = (rest: SupabaseRest): ClaudeTask<DossierInput, DossierOutput> => {
  const store = new SupabaseApprovalStore(rest);
  const { captureDeps } = supabaseConnectors(rest);
  return dossierTaskWith({
    listAwaiting: () => store.listAwaiting(),
    loadContext: (key) => loadDossierContext(captureDeps, key),
    requests: new SupabaseDossierRequests(rest),
  });
};
