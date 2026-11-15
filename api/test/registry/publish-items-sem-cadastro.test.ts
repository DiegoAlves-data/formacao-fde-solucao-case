// História #35, plano #66: a proposta aprovada com E8 publica o item ao Cadastro (AC-5).
import { beforeAll, describe, expect, it } from 'vitest';
import type { Published, RegistryCorrectionMessage, RegistryCorrectionOutbox } from '../../src/connectors/ports.js';
import {
  amountAtRiskSemCadastro,
  E8_APPROVAL_LEVEL,
} from '../../src/domain/checks/e8-item-sem-cadastro.js';
import { DockAction, Proposal, type Invoice } from '../../src/domain/index.js';
import { publishItemsSemCadastro } from '../../src/registry/publish-items-sem-cadastro.js';
import { kitDomain, kitInvoice, withItems, type KitDomain } from '../support/kit-domain.js';

/** #35 Caixa de saída em memória: guarda o que foi publicado. */
class FakeOutbox implements RegistryCorrectionOutbox {
  readonly published: Published<RegistryCorrectionMessage>[] = [];
  async publish(message: RegistryCorrectionMessage): Promise<Published<RegistryCorrectionMessage>> {
    const row = { ...message, id: this.published.length + 1, publishedAt: '2026-11-15T00:00:00Z' };
    this.published.push(row);
    return row;
  }
  async list(): Promise<Published<RegistryCorrectionMessage>[]> {
    return [...this.published];
  }
}

let kit: KitDomain;
beforeAll(async () => {
  kit = await kitDomain();
});

function checked(notaId: string): Invoice {
  // #66 Uma cópia: as notas do kit são compartilhadas entre os testes e a conferência muda o estado.
  const original = kitInvoice(kit, notaId);
  const invoice = withItems(original, original.items);
  invoice.check(kit.ctx);
  return invoice;
}

function proposalFor(invoice: Invoice, state: 'aprovada' | 'alterada' | 'aguardando_aprovacao'): Proposal {
  const proposal = Proposal.register({
    classification: invoice.classification,
    dockAction: DockAction.receive(),
    level: E8_APPROVAL_LEVEL,
    amountAtRisk: amountAtRiskSemCadastro(invoice, kit.ctx),
    justification: 'teste',
  });
  proposal.awaitApproval();
  if (state === 'aprovada') proposal.approve();
  if (state === 'alterada') proposal.alter(DockAction.receive(), 'recebe e corrige o cadastro');
  return proposal;
}

describe('#35 publicação ao Cadastro do item sem cadastro', () => {
  it('AC-5: proposta aprovada com E8 publica uma mensagem com o item F02-N27 da NF-009', async () => {
    const nf009 = checked('NF-009');
    const outbox = new FakeOutbox();

    const count = await publishItemsSemCadastro(nf009, proposalFor(nf009, 'aprovada'), kit.ctx, outbox);

    expect(count).toBe(1);
    expect(outbox.published).toHaveLength(1);
    const [message] = outbox.published;
    expect(message).toMatchObject({
      invoiceAccessKey: nf009.accessKey,
      kind: 'E8_item_sem_cadastro',
      supplierCode: 'F02-N27',
      sku: null,
    });
    expect(message?.detail).toContain('Isotônico limão 500 ml (lançamento)');
    expect(message?.detail).toContain('60 UN');
    expect(message?.detail).toContain('R$ 354,00');
  });

  it('AC-5: proposta alterada com E8 também publica', async () => {
    const nf009 = checked('NF-009');
    const outbox = new FakeOutbox();
    expect(await publishItemsSemCadastro(nf009, proposalFor(nf009, 'alterada'), kit.ctx, outbox)).toBe(1);
  });

  it('AC-5: proposta aguardando aprovação não publica nada', async () => {
    const nf009 = checked('NF-009');
    const outbox = new FakeOutbox();
    expect(await publishItemsSemCadastro(nf009, proposalFor(nf009, 'aguardando_aprovacao'), kit.ctx, outbox)).toBe(0);
    expect(outbox.published).toEqual([]);
  });

  it('AC-5: nota sem E8 não publica nada, mesmo aprovada', async () => {
    const nf001 = checked('NF-001');
    const outbox = new FakeOutbox();
    expect(await publishItemsSemCadastro(nf001, proposalFor(nf001, 'aprovada'), kit.ctx, outbox)).toBe(0);
    expect(outbox.published).toEqual([]);
  });
});
