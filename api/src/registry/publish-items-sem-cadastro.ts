// Caso de uso da história #35 (plano #66, AC-5): a proposta aprovada com E8 manda o item ao Cadastro.
import type { RegistryCorrectionOutbox } from '../connectors/ports.js';
import { itemsSemCadastro } from '../domain/checks/e8-item-sem-cadastro.js';
import type { CheckContext, InvoiceView, Proposal } from '../domain/index.js';

/**
 * #35, AC-5: se a proposta foi aprovada (ou alterada) e a nota tem E8, publica uma mensagem por item sem
 * cadastro na caixa de saída do Cadastro. Senão, não publica nada. Devolve quantas publicou.
 * Republicar é seguro: a caixa de saída é idempotente. Quem chama é o fluxo de aprovação (#63).
 */
export async function publishItemsSemCadastro(
  invoice: InvoiceView,
  proposal: Proposal,
  ctx: CheckContext,
  outbox: RegistryCorrectionOutbox,
): Promise<number> {
  const decided = proposal.state === 'aprovada' || proposal.state === 'alterada';
  if (!decided || !invoice.divergences.some((d) => d.classification === 'E8')) return 0;

  const items = itemsSemCadastro(invoice, ctx);
  for (const item of items) {
    await outbox.publish({
      invoiceAccessKey: invoice.accessKey,
      kind: 'E8_item_sem_cadastro',
      supplierCode: item.supplierCode,
      sku: item.sku,
      detail:
        `Cadastrar "${item.description}" do fornecedor ${invoice.supplierId}: ` +
        `${item.quantity.amount} ${item.quantity.unit} na nota ${invoice.number}, valor ${item.total.toString()}.`,
    });
  }
  return items.length;
}
