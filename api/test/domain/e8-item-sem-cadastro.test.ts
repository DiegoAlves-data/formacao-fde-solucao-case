// História #35, plano #66: o item sem cadastro é barrado e mandado ao Cadastro (E8).
import { beforeAll, describe, expect, it } from 'vitest';
import {
  amountAtRiskSemCadastro,
  checkItemSemCadastro,
  itemsSemCadastro,
} from '../../src/domain/checks/e8-item-sem-cadastro.js';
import { routeDivergences } from '../../src/domain/approval-policy.js';
import { Money, withDescriptionMatches, type DescriptionSuggester, type InvoiceItem } from '../../src/domain/index.js';
import { kitDomain, kitInvoice, withItems, type KitDomain } from '../support/kit-domain.js';

let kit: KitDomain;
beforeAll(async () => {
  kit = await kitDomain();
});

const E8_NOTES = ['NF-009', 'NF-017', 'NF-018', 'NF-022', 'NF-024', 'NF-046', 'NF-054', 'NF-061', 'NF-079'];

function first(notaId: string): InvoiceItem {
  const item = kitInvoice(kit, notaId).items[0];
  if (!item) throw new Error(`kit: ${notaId} sem itens`);
  return item;
}

/** #35 NF-001 com o primeiro item ("Refrigerante cola 2 L") sem SKU, com código desconhecido e outra descrição. */
function nf001ComDescricao(description: string) {
  const nf = kitInvoice(kit, 'NF-001');
  const [head, ...rest] = nf.items;
  if (!head) throw new Error('kit: NF-001 sem itens');
  return withItems(nf, [{ ...head, sku: null, supplierCode: 'F02-X99', description }, ...rest]);
}

function suggesting(pick: (candidates: readonly string[]) => number | null): DescriptionSuggester {
  return { suggest: async (_d, candidates) => pick(candidates) };
}

describe('#35 E8: item sem cadastro', () => {
  it('AC-1: a NF-009 do kit tem um E8 no item F02-N27, com a evidência do Cadastro', () => {
    const nf009 = kitInvoice(kit, 'NF-009');
    const found = checkItemSemCadastro(nf009, kit.ctx);

    expect(found).toHaveLength(1);
    const [e8] = found;
    expect(e8?.classification).toBe('E8');
    expect(e8?.skus).toEqual([]);
    expect(e8?.evidence).toHaveLength(1);
    const evidence = e8?.evidence[0];
    expect(evidence?.source).toBe('erp_cadastro');
    expect(evidence?.reference).toBe('F02/F02-N27');
    expect(evidence?.description).toContain('Isotônico limão 500 ml (lançamento)');
    expect(evidence?.description).toContain('F02-N27');
    expect(evidence?.description).toContain('SKU vazio');
    expect(evidence?.description).toContain('R$ 354,00');
    expect(evidence?.description).toMatch(/SKU.*código do fornecedor.*descrição/);
  });

  it('AC-1: cada nota do kit com item sem SKU e sem código no cadastro tem exatamente um E8', () => {
    for (const notaId of E8_NOTES) {
      expect(checkItemSemCadastro(kitInvoice(kit, notaId), kit.ctx), notaId).toHaveLength(1);
    }
  });

  it('AC-1: a NF-001 do kit, com todos os itens cadastrados, não tem E8', () => {
    expect(checkItemSemCadastro(kitInvoice(kit, 'NF-001'), kit.ctx)).toEqual([]);
  });

  it('AC-1: item com SKU desconhecido e código desconhecido é E8, e a divergência cita o SKU', () => {
    const nf = kitInvoice(kit, 'NF-001');
    const unknown = { ...first('NF-001'), sku: 'SKU-9999', supplierCode: 'F02-X99' };
    const found = checkItemSemCadastro(withItems(nf, [unknown]), kit.ctx);

    expect(found).toHaveLength(1);
    expect(found[0]?.skus).toEqual(['SKU-9999']);
    expect(found[0]?.evidence[0]?.description).toContain('SKU SKU-9999');
  });

  it('AC-1: item sem SKU mas com o código do fornecedor no cadastro não é E8', () => {
    const nf = kitInvoice(kit, 'NF-001');
    const semSku = { ...first('NF-001'), sku: null, description: 'Descrição que não casa com nada' };
    expect(checkItemSemCadastro(withItems(nf, [semSku]), kit.ctx)).toEqual([]);
  });

  it('AC-1: o cadastro de outro fornecedor não vale (SKU e código da F01 numa nota da F02)', () => {
    const nf = kitInvoice(kit, 'NF-001');
    const daF01 = kit.ctx.products.find((p) => p.supplierId === 'F01');
    if (!daF01) throw new Error('kit: F01 sem produtos');
    const item = { ...first('NF-001'), sku: daF01.sku, supplierCode: daF01.supplierCode, description: 'Item de outro fornecedor' };
    expect(checkItemSemCadastro(withItems(nf, [item]), kit.ctx)).toHaveLength(1);
  });

  it('AC-2: SKU vazio e código desconhecido, mas a descrição casa pela regra sozinha: não é E8', () => {
    expect(checkItemSemCadastro(nf001ComDescricao('Refrigerante cola 2 L'), kit.ctx)).toEqual([]);
  });

  it('AC-2: o Claude sugere um candidato que a regra confirma: não é E8', async () => {
    const nf = nf001ComDescricao('Refrigerante sabor cola 2 L');
    expect(checkItemSemCadastro(nf, kit.ctx)).toHaveLength(1); // #35 a regra sozinha não basta

    const candidates = kit.ctx.products.filter((p) => p.supplierId === 'F02').map((p) => p.description);
    const found = await withDescriptionMatches(
      suggesting((c) => c.indexOf('Refrigerante cola 2 L')),
      [{ description: 'Refrigerante sabor cola 2 L', candidates }],
      () => checkItemSemCadastro(nf, kit.ctx),
    );
    expect(found).toEqual([]);
  });

  it('AC-2: o Claude sugere um candidato que a regra recusa: é E8', async () => {
    const nf = nf001ComDescricao('Refrigerante sabor cola 2 L');
    const candidates = kit.ctx.products.filter((p) => p.supplierId === 'F02').map((p) => p.description);
    const found = await withDescriptionMatches(
      suggesting((c) => c.indexOf('Água mineral 1,5 L')),
      [{ description: 'Refrigerante sabor cola 2 L', candidates }],
      () => checkItemSemCadastro(nf, kit.ctx),
    );
    expect(found).toHaveLength(1);
  });

  it('AC-3: o item que nem o Claude nem a regra casam é E8, e o valor em risco da NF-009 é R$ 354,00', async () => {
    const nf009 = kitInvoice(kit, 'NF-009');
    const candidates = kit.ctx.products.filter((p) => p.supplierId === 'F02').map((p) => p.description);
    const items = await withDescriptionMatches(
      suggesting(() => null),
      [{ description: 'Isotônico limão 500 ml (lançamento)', candidates }],
      () => itemsSemCadastro(nf009, kit.ctx),
    );
    expect(items.map((i) => i.supplierCode)).toEqual(['F02-N27']);

    const atRisk = amountAtRiskSemCadastro(nf009, kit.ctx);
    expect(atRisk.amount.cents).toBe(35400);
    expect(atRisk.invoiceTotal.equals(nf009.total)).toBe(true);
  });

  it('AC-3: com dois itens sem cadastro, o valor em risco é a soma dos dois', () => {
    const nf009 = kitInvoice(kit, 'NF-009');
    const outro = nf009.items.find((i) => i.sku !== null);
    if (!outro) throw new Error('kit: NF-009 sem item cadastrado');
    const nf = withItems(
      nf009,
      nf009.items.map((i) => (i === outro ? { ...i, sku: 'SKU-9999', supplierCode: 'F02-X99' } : i)),
    );

    expect(checkItemSemCadastro(nf, kit.ctx)).toHaveLength(2);
    expect(amountAtRiskSemCadastro(nf, kit.ctx).amount.cents).toBe(35400 + outro.total.cents);
  });

  it('AC-3: sem item sem cadastro, o valor em risco é zero', () => {
    expect(amountAtRiskSemCadastro(kitInvoice(kit, 'NF-001'), kit.ctx).amount.isZero()).toBe(true);
  });

  it('AC-4: o E8 da NF-009 (R$ 354,00) vai para a coordenação, linha 3 da régua', () => {
    const nf009 = kitInvoice(kit, 'NF-009');
    const divergences = checkItemSemCadastro(nf009, kit.ctx);

    const route = routeDivergences(divergences, nf009.total);

    expect(route.level).toBe('coordenacao');
    expect(route.line).toBe(3);
  });

  it('AC-4: o E8 em nota acima de R$ 100 mil sobe para a diretoria; a regra 7 nunca baixa o nível', () => {
    const route = routeDivergences([{ classification: 'E8' }], Money.fromReais(150000));

    expect(route.level).toBe('diretoria');
  });
});
