import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  Divergence,
  Invoice,
  Money,
  Quantity,
  type CheckContext,
  type NamedCheck,
  type Payment,
} from '../../src/domain/index.js';
import {
  JANELA_DO_PAGAMENTO_FORA_DO_FLUXO_EM_DIAS, // ADR-002
  checkPagoForaDoFluxo, // ADR-002
} from '../../src/domain/checks/e7-pago-fora-do-fluxo.js';
import { emptyContext } from './fixtures.js';

// História #33, plano #64: E7, pagamento no banco sem a nota passar pelo contas a pagar.

type InvoiceArgs = { supplierId: string; store: string; issuedOn: string; total: Money };

/** Nota sem pedido, como a compra emergencial da loja chega na base do kit. */
const aLateInvoice = ({ supplierId, store, issuedOn, total }: InvoiceArgs): Invoice =>
  Invoice.receive({
    accessKey: `NFE-${supplierId}-${store}-${issuedOn}`,
    number: '9001',
    series: '1',
    supplierId,
    store,
    issuedOn,
    purchaseOrderRef: null,
    entryChannel: 'sefaz',
    items: [
      {
        supplierCode: 'X1',
        sku: 'SKU-X',
        description: 'Compra emergencial',
        quantity: Quantity.of(1, 'UN'),
        unitPrice: total,
        total,
      },
    ],
    total,
  });

/** O pagamento como o conector do banco o entrega: reais com casas decimais. */
const aPayment = (overrides: Partial<Payment> & { reais?: number } = {}): Payment => {
  const { reais = 3430.0, ...rest } = overrides;
  return {
    id: 'PG-5301',
    supplierId: 'F09',
    store: 'LJ-025',
    paidOn: '2026-11-02',
    amount: Money.fromReais(reais),
    method: 'boleto avulso',
    origin: 'compra emergencial da loja, fora do fluxo',
    invoiceAccessKey: null,
    ...rest,
  };
};

const notaF09 = (): Invoice =>
  aLateInvoice({ supplierId: 'F09', store: 'LJ-025', issuedOn: '2026-11-09', total: Money.ofCents(343000) });

const frozen = (ctx: CheckContext): CheckContext => {
  for (const list of Object.values(ctx)) Object.freeze(list);
  return Object.freeze(ctx);
};

describe('E7 — pago fora do fluxo (história #33)', () => {
  describe('AC-1: liga a nota ao pagamento fora do fluxo', () => {
    it('AC-1 (regra 2): PG-5301 do kit, F09 / LJ-025, 7 dias antes da nota, mesmo valor → E7', () => {
      const ctx = emptyContext({ payments: [aPayment()] });

      const result = checkPagoForaDoFluxo(notaF09(), ctx);

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(Divergence);
      expect(result[0]?.classification).toBe('E7');
      expect(result[0]?.skus).toEqual([]);
    });

    it('AC-1 (regra 2): PG-5325 do kit, F02 / LJ-009, 8 dias antes (o maior intervalo do kit) → E7', () => {
      const nota = aLateInvoice({
        supplierId: 'F02',
        store: 'LJ-009',
        issuedOn: '2026-11-09',
        total: Money.ofCents(233324),
      });
      const payment = aPayment({
        id: 'PG-5325',
        supplierId: 'F02',
        store: 'LJ-009',
        paidOn: '2026-11-01',
        reais: 2333.24,
      });

      const result = checkPagoForaDoFluxo(nota, emptyContext({ payments: [payment] }));

      expect(result.map((d) => d.classification)).toEqual(['E7']);
      expect(result[0]?.evidence[0]?.reference).toBe('PG-5325');
    });

    it('AC-1 (regra 2): sem pagamento nenhum → []', () => {
      expect(checkPagoForaDoFluxo(notaF09(), emptyContext())).toEqual([]);
    });
  });

  describe('AC-1: o que não é pago fora do fluxo', () => {
    it('AC-1 (regra 2): fornecedor diferente → []', () => {
      const ctx = emptyContext({ payments: [aPayment({ supplierId: 'F10' })] });
      expect(checkPagoForaDoFluxo(notaF09(), ctx)).toEqual([]);
    });

    it('AC-1 (regra 2): destino diferente → []', () => {
      const ctx = emptyContext({ payments: [aPayment({ store: 'LJ-026' })] });
      expect(checkPagoForaDoFluxo(notaF09(), ctx)).toEqual([]);
    });

    it('AC-1 (regra 2): valor diferente em 1 centavo → []', () => {
      const ctx = emptyContext({ payments: [aPayment({ reais: 3430.01 }), aPayment({ id: 'PG-2', reais: 3429.99 })] });
      expect(checkPagoForaDoFluxo(notaF09(), ctx)).toEqual([]);
    });

    it('AC-1 (regra 2): pagamento depois da emissão → []', () => {
      const ctx = emptyContext({ payments: [aPayment({ paidOn: '2026-11-10' })] });
      expect(checkPagoForaDoFluxo(notaF09(), ctx)).toEqual([]);
    });

    it('AC-1 (regra 2): pagamento a 31 dias da emissão, fora da janela → []', () => {
      const ctx = emptyContext({ payments: [aPayment({ paidOn: '2026-10-09' })] });
      expect(checkPagoForaDoFluxo(notaF09(), ctx)).toEqual([]);
    });

    it('AC-1 (regra 2): pagamento que já tem título no contas a pagar → []', () => {
      const ctx = emptyContext({
        payments: [aPayment({ invoiceAccessKey: '35261100000000000000550010000099991000099999' })],
      });
      expect(checkPagoForaDoFluxo(notaF09(), ctx)).toEqual([]);
    });
  });

  describe('AC-1: a janela do pagamento', () => {
    it(`AC-1 (regra 2): a janela é de ${JANELA_DO_PAGAMENTO_FORA_DO_FLUXO_EM_DIAS} dias`, () => {
      expect(JANELA_DO_PAGAMENTO_FORA_DO_FLUXO_EM_DIAS).toBe(30);
    });

    it('AC-1 (regra 2): pagamento exatamente 30 dias antes da emissão → E7', () => {
      const ctx = emptyContext({ payments: [aPayment({ paidOn: '2026-10-10' })] });
      expect(checkPagoForaDoFluxo(notaF09(), ctx).map((d) => d.classification)).toEqual(['E7']);
    });

    it('AC-1 (regra 2): pagamento no mesmo dia da emissão → E7', () => {
      const ctx = emptyContext({ payments: [aPayment({ paidOn: '2026-11-09' })] });
      expect(checkPagoForaDoFluxo(notaF09(), ctx).map((d) => d.classification)).toEqual(['E7']);
    });

    it('AC-1 (regra 2): a janela atravessa a virada do mês por dias corridos', () => {
      const nota = aLateInvoice({
        supplierId: 'F09',
        store: 'LJ-025',
        issuedOn: '2026-03-01',
        total: Money.ofCents(343000),
      });
      const ctx = emptyContext({ payments: [aPayment({ paidOn: '2026-01-30' })] });
      expect(checkPagoForaDoFluxo(nota, ctx).map((d) => d.classification)).toEqual(['E7']);
    });
  });

  describe('AC-2 (regra 6): a evidência é o vínculo da nota ao pagamento', () => {
    it('AC-2 (regra 6): cita o banco e o pagamento, com valor, data, forma, origem e "sem título"', () => {
      const [divergence] = checkPagoForaDoFluxo(notaF09(), emptyContext({ payments: [aPayment()] }));

      expect(divergence?.evidence).toHaveLength(1);
      const [evidence] = divergence?.evidence ?? [];
      expect(evidence?.source).toBe('banco');
      expect(evidence?.reference).toBe('PG-5301');
      expect(evidence?.description).toContain('PG-5301');
      expect(evidence?.description).toContain(Money.ofCents(343000).toString());
      expect(evidence?.description).toContain('2026-11-02');
      expect(evidence?.description).toContain('boleto avulso');
      expect(evidence?.description).toContain('compra emergencial da loja, fora do fluxo');
      expect(evidence?.description).toContain('sem título');
    });

    it('AC-2 (regra 6): com dois candidatos, vincula o de data mais próxima da emissão', () => {
      const ctx = emptyContext({
        payments: [aPayment({ id: 'PG-A', paidOn: '2026-10-20' }), aPayment({ id: 'PG-B', paidOn: '2026-11-05' })],
      });

      const result = checkPagoForaDoFluxo(notaF09(), ctx);

      expect(result).toHaveLength(1);
      expect(result[0]?.evidence.map((e) => e.reference)).toEqual(['PG-B']);
    });

    it('AC-2 (regra 6): empate na data, vincula o de menor id, em qualquer ordem de chegada', () => {
      const z = aPayment({ id: 'PG-9', paidOn: '2026-11-05' });
      const a = aPayment({ id: 'PG-1', paidOn: '2026-11-05' });

      for (const payments of [[z, a], [a, z]]) {
        const result = checkPagoForaDoFluxo(notaF09(), emptyContext({ payments }));
        expect(result).toHaveLength(1);
        expect(result[0]?.evidence.map((e) => e.reference)).toEqual(['PG-1']);
      }
    });

    it('AC-2 (regra 6): ignora o candidato com título e vincula o que está sem título', () => {
      const ctx = emptyContext({
        payments: [
          aPayment({ id: 'PG-COM', paidOn: '2026-11-08', invoiceAccessKey: 'CHAVE-JA-LANCADA' }),
          aPayment({ id: 'PG-SEM', paidOn: '2026-11-01' }),
        ],
      });
      const result = checkPagoForaDoFluxo(notaF09(), ctx);
      expect(result.map((d) => d.evidence[0]?.reference)).toEqual(['PG-SEM']);
    });
  });

  describe('AC-3 (regra 2): na ordem da conferência', () => {
    it('AC-3 (regra 2): pela Invoice.check com as verificações reais, a nota sai E7 e a primeira divergência é E7', () => {
      const nota = notaF09();

      nota.check(emptyContext({ payments: [aPayment()] }), CHECKS);

      expect(nota.classification).toBe('E7');
      expect(nota.divergences[0]?.classification).toBe('E7');
    });

    it('AC-3 (regra 2): quando a duplicidade (E6) acha algo, o E7 não roda', () => {
      const calls: string[] = [];
      const e6: NamedCheck = {
        id: 'E6',
        run: () => [
          Divergence.of({
            classification: 'E6',
            skus: [],
            evidence: [{ source: 'erp_contas_a_pagar', reference: 'T-1', description: 'já lançada' }],
          }),
        ],
      };
      const e7: NamedCheck = {
        id: 'E7',
        run: (invoice, ctx) => {
          calls.push('E7');
          return checkPagoForaDoFluxo(invoice, ctx);
        },
      };
      const nota = notaF09();

      nota.check(emptyContext({ payments: [aPayment()] }), [e6, e7]);

      expect(calls).toEqual([]);
      expect(nota.divergences.map((d) => d.classification)).toEqual(['E6']);
      expect(nota.classification).toBe('E6');
    });
  });

  it('regra 2: a verificação não altera o contexto', () => {
    const payments = [aPayment({ id: 'PG-2', paidOn: '2026-11-01' }), aPayment({ id: 'PG-1', paidOn: '2026-11-01' })];
    const ctx = frozen(emptyContext({ payments }));

    expect(() => checkPagoForaDoFluxo(notaF09(), ctx)).not.toThrow();
    expect(ctx.payments.map((p) => p.id)).toEqual(['PG-2', 'PG-1']);
  });
});
