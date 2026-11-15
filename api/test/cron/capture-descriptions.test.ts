// História #35, plano #66: o Cron consulta o Claude numa rodada antes de conferir (AC-2).
import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { matchByDescription, type DescriptionMatchRequest, type DescriptionSuggester } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

type Row = Record<string, unknown>;

/** #35 O kit com o item SKU-1006 da NF-001 sem SKU, com código desconhecido e descrição que a regra sozinha não casa. */
function kitComItemSemSku(): { tables: Record<string, Row[]>; chave: string } {
  const tables = kitTables();
  const notas = tables.kit_notas ?? [];
  const chave = String(notas.find((n) => n.nota_id === 'NF-001')?.chave);
  const itens = tables.kit_nota_itens ?? [];
  const item = itens.find((i) => i.chave === chave && i.sku === 'SKU-1006');
  if (!item) throw new Error('kit: item SKU-1006 da NF-001 não encontrado');
  Object.assign(item, { sku: null, codigo_fornecedor: 'F02-X99', descricao: 'Refrigerante sabor cola 2 L' });
  return { tables, chave };
}

function deps(fake: FakePostgrest) {
  return supabaseConnectors(
    new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch }),
  ).captureDeps;
}

function classificationOf(fake: FakePostgrest, chave: string): unknown {
  return fake.rows('invoices').find((r) => r.access_key === chave)?.classification;
}

describe('#35 Cron com o Claude no casamento por descrição', () => {
  it('AC-2: com o sugestor, a verificação vê a sugestão durante a rodada e o cache fica vazio depois', async () => {
    const { tables, chave } = kitComItemSemSku();
    const fake = new FakePostgrest(tables);
    const asked: DescriptionMatchRequest[] = [];
    const descriptions: DescriptionSuggester = {
      async suggest(description, candidates) {
        asked.push({ description, candidates });
        const index = candidates.indexOf('Refrigerante cola 2 L');
        return description === 'Refrigerante sabor cola 2 L' && index >= 0 ? index : null;
      },
    };

    await captureInvoices({ ...deps(fake), descriptions });

    const pedido = asked.find((r) => r.description === 'Refrigerante sabor cola 2 L');
    expect(pedido?.candidates).toContain('Refrigerante cola 2 L');
    expect(asked.every((r) => r.candidates.length > 0)).toBe(true);
    expect(classificationOf(fake, chave)).not.toBe('E8');
    expect(classificationOf(fake, kitTables().kit_notas?.find((n) => n.nota_id === 'NF-009')?.chave as string)).toBe('E8');
    // #35 Depois da rodada, a regra decide sozinha de novo.
    expect(matchByDescription('Refrigerante sabor cola 2 L', pedido?.candidates ?? [])).toBeNull();
  });

  it('AC-2: sem o sugestor, nada muda: a regra sozinha decide e o item vira E8', async () => {
    const { tables, chave } = kitComItemSemSku();
    const fake = new FakePostgrest(tables);

    const result = await captureInvoices(deps(fake));

    expect(result).toEqual({ seen: 80, inserted: 80, checked: 80 });
    expect(classificationOf(fake, chave)).toBe('E8');
  });
});
