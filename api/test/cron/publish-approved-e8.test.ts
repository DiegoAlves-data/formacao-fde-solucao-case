// História #35, plano #66 (AC-5): o Cron manda ao Cadastro os E8 das propostas já decididas por uma pessoa.
import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryApprovalStore, type CaseFile } from '../../src/approval/store.js';
import type { Published, RegistryCorrectionMessage, RegistryCorrectionOutbox, RegistryPort } from '../../src/connectors/ports.js';
import { publishApprovedSemCadastro } from '../../src/cron/publish-approved-e8.js';
import { propose } from '../../src/domain/approval.js';
import { ApprovalPolicy, type ApprovalRoute } from '../../src/domain/approval-policy.js';
import { amountAtRiskSemCadastro } from '../../src/domain/checks/e8-item-sem-cadastro.js';
import type { Approval } from '../../src/domain/approval.js';
import { DockAction, Money, Proposal, Title, type Invoice } from '../../src/domain/index.js';
import { kitDomain, kitInvoice, withItems, type KitDomain } from '../support/kit-domain.js';

const DIA = '2026-11-15';

/** #35 Caixa de saída em memória e idempotente como a do Supabase (#59): a mesma nota e o mesmo item entram uma vez. */
class IdempotentOutbox implements RegistryCorrectionOutbox {
  readonly published: Published<RegistryCorrectionMessage>[] = [];
  async publish(message: RegistryCorrectionMessage): Promise<Published<RegistryCorrectionMessage>> {
    const existing = this.published.find(
      (m) => m.invoiceAccessKey === message.invoiceAccessKey && m.kind === message.kind && m.supplierCode === message.supplierCode,
    );
    if (existing) return existing;
    const row = { ...message, id: this.published.length + 1, publishedAt: '2026-11-15T00:00:00Z' };
    this.published.push(row);
    return row;
  }
  async list(): Promise<Published<RegistryCorrectionMessage>[]> {
    return [...this.published];
  }
}

let kit: KitDomain;
let registry: RegistryPort;
beforeAll(async () => {
  kit = await kitDomain();
  registry = { listSuppliers: async () => [...kit.ctx.suppliers], listProducts: async () => [...kit.ctx.products] };
});

function checked(notaId: string): Invoice {
  // #66 Uma cópia: as notas do kit são compartilhadas entre os testes e a conferência muda o estado.
  const original = kitInvoice(kit, notaId);
  const invoice = withItems(original, original.items);
  invoice.check(kit.ctx);
  return invoice;
}

/** #35 Nota sem divergência: a régua aprova sem pessoa e o processo entra decidido, como no #63. */
function ruleCaseFile(invoice: Invoice, route: ApprovalRoute): CaseFile {
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: invoice.issuedOn });
  const { proposal, approval } = propose(invoice, title, {
    route,
    dockAction: DockAction.receive(),
    amountAtRisk: Money.zero(),
    justification: 'teste',
    today: DIA,
  });
  return { invoice, proposal, title, route, approval, supplierBlocked: false };
}

function caseFile(invoice: Invoice, state: 'aprovada' | 'alterada' | 'aguardando_aprovacao' | 'regra'): CaseFile {
  const route = ApprovalPolicy.route(invoice);
  if (state === 'regra') return ruleCaseFile(invoice, route);
  const proposal = Proposal.register({
    classification: invoice.classification,
    dockAction: DockAction.receive(),
    level: route.level,
    amountAtRisk: amountAtRiskSemCadastro(invoice, kit.ctx),
    justification: 'teste',
  });
  proposal.awaitApproval();
  if (state === 'aprovada') proposal.approve();
  if (state === 'alterada') proposal.alter(DockAction.receive(), 'recebe e corrige o cadastro');
  const approval: Approval | null =
    state === 'aguardando_aprovacao'
      ? null
      : Object.freeze({
          approver: 'coordenacao@jachegou.test',
          approverLevel: 'coordenacao',
          dockAction: proposal.dockAction,
          justification: 'teste',
          decidedOn: DIA,
        });
  const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: invoice.issuedOn });
  return { invoice, proposal, title, route, approval, supplierBlocked: false };
}

describe('#35 Cron: E8 aprovado vai à caixa de saída do Cadastro', () => {
  it('AC-5: a NF-009 aprovada publica uma mensagem E8 com o item F02-N27', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'aprovada')]);

    const result = await publishApprovedSemCadastro({ store, registry, outbox, days: [DIA] });

    expect(result).toEqual({ published: 1 });
    expect(outbox.published).toHaveLength(1);
    expect(outbox.published[0]).toMatchObject({ kind: 'E8_item_sem_cadastro', supplierCode: 'F02-N27' });
  });

  it('AC-5: a proposta alterada também publica', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'alterada')]);

    expect(await publishApprovedSemCadastro({ store, registry, outbox, days: [DIA] })).toEqual({ published: 1 });
  });

  it('AC-5: proposta aguardando aprovação não publica nada', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'aguardando_aprovacao')]);

    expect(await publishApprovedSemCadastro({ store, registry, outbox, days: [DIA] })).toEqual({ published: 0 });
    expect(outbox.published).toHaveLength(0);
  });

  it('AC-5: nota aprovada sem E8 não publica nada', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-001'), 'regra')]);

    expect(await publishApprovedSemCadastro({ store, registry, outbox, days: [DIA] })).toEqual({ published: 0 });
    expect(outbox.published).toHaveLength(0);
  });

  it('AC-5: decidida fora dos dias pedidos não publica', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'aprovada')]);

    expect(await publishApprovedSemCadastro({ store, registry, outbox, days: ['2026-11-01'] })).toEqual({ published: 0 });
  });

  it('AC-5: rodar duas vezes no mesmo dia deixa uma só mensagem', async () => {
    const outbox = new IdempotentOutbox();
    const store = new MemoryApprovalStore([caseFile(checked('NF-009'), 'aprovada')]);

    await publishApprovedSemCadastro({ store, registry, outbox, days: [DIA] });
    await publishApprovedSemCadastro({ store, registry, outbox, days: [DIA] });

    expect(outbox.published).toHaveLength(1);
  });
});
