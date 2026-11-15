// #35 (plano #66, AC-5): o Cron manda ao Cadastro o item sem cadastro das propostas já aprovadas por uma pessoa.
import type { ApprovalStore } from '../approval/store.js';
import type { RegistryCorrectionOutbox, RegistryPort } from '../connectors/ports.js';
import type { CheckContext } from '../domain/context.js';
import { publishItemsSemCadastro } from '../registry/publish-items-sem-cadastro.js';

export type PublishApprovedDeps = {
  readonly store: Pick<ApprovalStore, 'listDecidedOn'>;
  readonly registry: RegistryPort;
  readonly outbox: RegistryCorrectionOutbox;
  /** Os dias (AAAA-MM-DD) cujas decisões entram na rodada. */
  readonly days: readonly string[];
};

/**
 * #35, AC-5: para cada processo decidido nos dias dados, com proposta aprovada ou alterada e um E8 na nota,
 * publica na caixa de saída do Cadastro. A caixa é idempotente (#59): repetir o dia não cria mensagem nova.
 */
export async function publishApprovedSemCadastro(deps: PublishApprovedDeps): Promise<{ published: number }> {
  const files = (await Promise.all(deps.days.map((day) => deps.store.listDecidedOn(day)))).flat();
  const withE8 = files.filter(
    (f) =>
      (f.proposal.state === 'aprovada' || f.proposal.state === 'alterada') &&
      f.invoice.divergences.some((d) => d.classification === 'E8'),
  );
  if (withE8.length === 0) return { published: 0 };

  const [products, suppliers] = await Promise.all([deps.registry.listProducts(), deps.registry.listSuppliers()]);
  const ctx: CheckContext = {
    purchaseOrders: [],
    suppliers,
    products,
    postedInvoices: [],
    payments: [],
    receipts: [],
    capturedInvoices: [],
  };
  let published = 0;
  for (const file of withE8) {
    published += await publishItemsSemCadastro(file.invoice, file.proposal, ctx, deps.outbox);
  }
  return { published };
}
