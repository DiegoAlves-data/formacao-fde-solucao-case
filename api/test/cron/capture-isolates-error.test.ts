import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #56: uma nota que quebra na conferência não derruba a rodada do Cron. Ela fica a conferir,
// #56: marcada com o motivo, e as outras seguem. A nota do PG-5301 (F09 / LJ-025) chega com a
// #56: data de emissão fora do formato, e o E7 recusa a data (#64).
const BROKEN_SUFFIX = '74374841';

const withBrokenIssueDate = () => {
  const tables = kitTables();
  const kitInvoice = tables.kit_notas!.find((n) => String(n.chave).endsWith(BROKEN_SUFFIX))!;
  kitInvoice.data_emissao = '09/11/2026';
  return tables;
};

const run = async (fake: FakePostgrest) => {
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  return captureInvoices(supabaseConnectors(rest).captureDeps);
};

type Row = Record<string, unknown>;
const broken = (fake: FakePostgrest): Row =>
  (fake.rows('invoices') as Row[]).find((r) => String(r.access_key).endsWith(BROKEN_SUFFIX))!;

describe('#56 o Cron isola o erro por nota', () => {
  it('a nota que quebra fica a conferir com o motivo; as outras 79 são conferidas', async () => {
    const fake = new FakePostgrest(withBrokenIssueDate());

    const result = await run(fake);

    expect(result).toEqual({ seen: 80, inserted: 80, checked: 79, failed: 1 });
    expect(broken(fake)).toMatchObject({ state: 'a_conferir', checked_at: null });
    expect(String(broken(fake).check_error)).toContain('09/11/2026');
    const others = (fake.rows('invoices') as Row[]).filter((r) => r !== broken(fake));
    expect(others.every((r) => r.state === 'conferida' && r.check_error == null)).toBe(true);
  });

  it('corrigida a data, a rodada seguinte confere a nota e limpa o motivo', async () => {
    const fake = new FakePostgrest(withBrokenIssueDate());
    await run(fake);
    const kitInvoice = fake.rows('kit_notas').find((n) => String(n.chave).endsWith(BROKEN_SUFFIX))!;
    kitInvoice.data_emissao = '2026-11-09';
    const invoice = broken(fake);
    invoice.issued_on = '2026-11-09';

    const result = await run(fake);

    expect(result).toEqual({ seen: 80, inserted: 0, checked: 1, failed: 0 });
    expect(broken(fake)).toMatchObject({ state: 'conferida', classification: 'E7', check_error: null });
  });
});
