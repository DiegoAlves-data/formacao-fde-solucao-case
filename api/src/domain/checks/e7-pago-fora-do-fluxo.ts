import type { Payment } from '../context.js';
import { Divergence } from '../divergence.js';
import { DomainError } from '../errors.js';
import type { InvoiceView } from '../invoice.js';
import type { Check } from './check.js';

/**
 * Regra 2, decisão em aberto 5: quantos dias antes da emissão um pagamento sem título ainda se
 * liga à nota tardia de uma compra emergencial. Na base do kit o intervalo vai de 4 a 8 dias.
 */
export const OUT_OF_FLOW_PAYMENT_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** #64: data ISO `YYYY-MM-DD` em dias corridos UTC, sem fuso; data fora do formato é erro. */
const toUtcDay = (isoDate: string): number => {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? Date.parse(`${isoDate}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(ms)) throw new DomainError(`E7: data fora do formato YYYY-MM-DD: ${isoDate}`);
  return Math.floor(ms / MS_PER_DAY);
};

/** #64: quantos dias o pagamento veio antes da emissão; negativo quando veio depois. */
const daysBeforeIssue = (invoice: InvoiceView, payment: Payment): number =>
  toUtcDay(invoice.issuedOn) - toUtcDay(payment.paidOn);

const isOutOfFlowPaymentFor = (invoice: InvoiceView, payment: Payment): boolean => {
  if (payment.invoiceAccessKey !== null) return false; // #64: já tem título, passou pelo fluxo
  if (payment.supplierId !== invoice.supplierId || payment.store !== invoice.store) return false;
  if (!payment.amount.equals(invoice.total)) return false;
  const days = daysBeforeIssue(invoice, payment);
  return days >= 0 && days <= OUT_OF_FLOW_PAYMENT_WINDOW_DAYS;
};

/** #64: vincula um só: o de data mais próxima da emissão; empate pelo menor id. */
const closestToIssue =
  (invoice: InvoiceView) =>
  (a: Payment, b: Payment): number =>
    daysBeforeIssue(invoice, a) - daysBeforeIssue(invoice, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const describeLink = (payment: Payment): string =>
  `Pagamento ${payment.id} de ${payment.amount.toString()} em ${payment.paidOn}, ` +
  `por ${payment.method} (${payment.origin}), sem título no contas a pagar`;

/**
 * E7 — pago fora do fluxo: pagamento no banco sem a nota passar pelo contas a pagar.
 * Regra que rege: regras 2 e 6.
 * Dona: plano #64 (história #33).
 *
 * Casa fornecedor, destino, valor em centavos exatos e a data dentro da janela; a evidência é o
 * vínculo da nota ao pagamento escolhido.
 */
export const checkPagoForaDoFluxo: Check = (invoice, ctx) => { // ADR-002
  const [linked] = ctx.payments
    .filter((payment) => isOutOfFlowPaymentFor(invoice, payment))
    .sort(closestToIssue(invoice));
  if (linked === undefined) return [];
  return [
    Divergence.of({
      classification: 'E7',
      skus: [],
      evidence: [{ source: 'banco', reference: linked.id, description: describeLink(linked) }], // ADR-002
    }),
  ];
};
