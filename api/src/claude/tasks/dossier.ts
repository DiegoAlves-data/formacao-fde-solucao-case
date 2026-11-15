// #38: tarefa do Claude (#66, #171) que escreve o dossiê da proposta encaminhada a uma pessoa.
// #38 A tarefa não decide nem grava: o laço registra a saída em claude_suggestions, e a gaveta lê e confere
// cada número contra o banco na hora de mostrar (readDossier, #68). Ação, nível e valor em risco vêm da regra.
import type { Ask } from '../client.js';
import type { ClaudeTask } from '../task.js';
import { SupabaseApprovalStore } from '../../approval/supabase-store.js';
import { supabaseConnectors } from '../../connectors/supabase-connectors.js';
import type { SupabaseRest } from '../../connectors/supabase-rest.js';
import { loadDossierContext } from '../../dossier/context.js';
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
};

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

/** #38 A tarefa sobre fontes injetadas; `dossierTask` liga ao Supabase. */
export function dossierTaskWith(deps: DossierTaskDeps): ClaudeTask<DossierInput, DossierOutput> {
  return {
    name: DOSSIER_TASK,

    /**
     * #38 AC-1 e AC-6: as propostas que esperam uma pessoa. O laço tira as que já têm linha ok e espera as
     * que erraram, e a linha é única por (task, chave), então o mesmo evento não gera duas chamadas.
     */
    async pending() {
      const files = (await deps.listAwaiting()).filter(needsDossier);
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
      if (!output) throw new Error('dossier: resposta do Claude fora do formato');
      return output;
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
  });
};
