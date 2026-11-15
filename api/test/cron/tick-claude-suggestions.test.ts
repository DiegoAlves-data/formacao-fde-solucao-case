// #66 O tick lê as sugestões gravadas pelo job do Claude e as usa na conferência.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { descriptionMatchKey } from '../../src/connectors/claude-suggestions.js';
import { tick } from '../../src/cron/tick.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

type Row = Record<string, unknown>;

const DESCRIPTION = 'Refrigerante sabor cola 2 L';

/** #66 O kit com o item SKU-1006 da NF-001 sem SKU, código desconhecido e descrição que a regra sozinha não casa. */
function kitComItemSemSku(): { tables: Record<string, Row[]>; accessKey: string; candidates: string[] } {
  const tables = kitTables();
  const accessKey = String(tables.kit_notas?.find((n) => n.nota_id === 'NF-001')?.chave);
  const item = tables.kit_nota_itens?.find((i) => i.chave === accessKey && i.sku === 'SKU-1006');
  if (!item) throw new Error('kit: item SKU-1006 da NF-001 não encontrado');
  Object.assign(item, { sku: null, codigo_fornecedor: 'F02-X99', descricao: DESCRIPTION });
  const candidates = (tables.kit_produtos ?? []).filter((p) => p.fornecedor_id === 'F02').map((p) => String(p.descricao));
  return { tables, accessKey, candidates };
}

const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };

function classificationOf(fake: FakePostgrest, accessKey: string): unknown {
  return fake.rows('invoices').find((r) => r.access_key === accessKey)?.classification;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#66 tick com as sugestões gravadas', () => {
  it('AC-2: com a sugestão gravada que a regra confirma, o item de SKU vazio deixa de ser E8', async () => {
    const { tables, accessKey, candidates } = kitComItemSemSku();
    tables.claude_suggestions = [
      {
        task: 'description-match',
        input_key: await descriptionMatchKey(DESCRIPTION, candidates),
        input: { description: DESCRIPTION, candidates },
        output: { match: 'Refrigerante cola 2 L' },
        status: 'ok',
        model: 'claude-haiku',
        created_at: '2026-11-15T00:00:00Z',
      },
    ];
    const fake = new FakePostgrest(tables);
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await tick({ cron: '*/15 * * * *' }, ENV);

    expect(classificationOf(fake, accessKey)).not.toBe('E8');
  });

  it('AC-2: sem a sugestão gravada, o mesmo item é E8', async () => {
    const { tables, accessKey } = kitComItemSemSku();
    tables.claude_suggestions = [];
    const fake = new FakePostgrest(tables);
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await tick({ cron: '*/15 * * * *' }, ENV);

    expect(classificationOf(fake, accessKey)).toBe('E8');
  });

  it('AC-2: se a leitura das sugestões falha, loga sem dado sensível e a regra decide sozinha', async () => {
    const { tables, accessKey } = kitComItemSemSku();
    const fake = new FakePostgrest(tables);
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      input.includes('/rest/v1/claude_suggestions')
        ? Promise.resolve(new Response('{"message":"relation does not exist"}', { status: 404 }))
        : fake.fetch(input, init),
    );
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await tick({ cron: '*/15 * * * *' }, ENV);

    expect(classificationOf(fake, accessKey)).toBe('E8');
    expect(logs.some((l) => l.includes('sugestões do Claude indisponíveis'))).toBe(true);
    expect(logs.join('\n')).not.toContain('sb_secret_fake');
  });
});
