import { describe, expect, it } from 'vitest';
import { approve, draftProposal, propose, type Approver } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { DockAction, Money, Quantity, Title, type Payment } from '../../src/domain/index.js';
import { kitContext, kitInvoice, kitSupplier } from './kit.js';

// #64 / #33 AC-2 e AC-4: a nota E7 fica vinculada ao pagamento já feito, vai para a coordenação
// #64: (linha 3) e nenhum título dela vai para a lista do dia, seja qual for a ação na doca.
const TODAY = '2026-11-15';
const coordenacao: Approver = { email: 'coordenacao@jachegou.test', level: 'coordenacao' };

// #64: o PG-5301 da base do kit, pago pela loja antes da NF-069 chegar.
const PG_5301: Payment = {
  id: 'PG-5301',
  supplierId: 'F09',
  store: 'LJ-025',
  paidOn: '2026-11-02',
  amount: Money.fromReais(3430.0),
  method: 'boleto avulso',
  origin: 'compra emergencial da loja, fora do fluxo',
  invoiceAccessKey: null,
};

function proposedE7() {
  const invoice = kitInvoice('NF-069');
  invoice.check({ ...kitContext(), payments: [PG_5301] });
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: TODAY });
  const route = ApprovalPolicy.route(invoice, kitSupplier(invoice.supplierId));
  const draft = draftProposal(invoice, null);
  const { proposal } = propose(invoice, title, { route, ...draft, today: TODAY });
  return { invoice, title, route, draft, proposal };
}

describe('#64 E7 na aprovação: vinculada ao pagamento, sem pagar de novo', () => {
  it('AC-4 (linha 3): a NF-069 sai E7 e vai para a coordenação', () => {
    const { invoice, route, proposal } = proposedE7();
    expect(invoice.classification).toBe('E7');
    expect(route).toMatchObject({ line: 3, level: 'coordenacao' });
    expect(proposal.state).toBe('aguardando_aprovacao');
  });

  it('AC-2: a proposta cita o pagamento vinculado e põe o valor da nota em risco', () => {
    const { invoice, draft } = proposedE7();
    expect(draft.amountAtRisk.equals(invoice.total)).toBe(true);
    expect(draft.justification).toContain('PG-5301');
  });

  it('AC-2: aprovada como proposta, o título não vai para a lista do dia', () => {
    const { invoice, proposal, title } = proposedE7();
    approve(invoice, proposal, title, coordenacao, { kind: 'aprovar' }, TODAY);
    expect(title.state).toBe('bloqueado');
  });

  it('AC-2: alterada para receber parcial, o título também não vai para a lista do dia', () => {
    const { invoice, proposal, title } = proposedE7();
    const item = invoice.items.find((i) => i.sku !== null && i.quantity.amount > 1);
    expect(item, '#64 a NF-069 tem item com SKU e mais de uma unidade').toBeDefined();
    const partial = DockAction.partial([
      { sku: item!.sku!, quantity: Quantity.of(1, item!.quantity.unit), disposition: 'devolver' },
    ]);
    approve(invoice, proposal, title, coordenacao, { kind: 'alterar', dockAction: partial, justification: 'devolve um' }, TODAY);
    expect(title.state).toBe('bloqueado');
  });
});
