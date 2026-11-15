import { describe, expect, it } from 'vitest';
import { BankConnector } from '../../src/connectors/bank.js';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #56: o conector do banco valida a data do pagamento na borda (#64). Um pagamento é dinheiro que
// #56: já saiu; esconder a linha arriscaria pagar de novo, então a leitura falha alto, com a tabela.
const bankOver = (pagamentos: Record<string, unknown>[]) => {
  const fake = new FakePostgrest({ kit_pagamentos: pagamentos });
  return new BankConnector(new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch }));
};

describe('#56 data do pagamento no conector do banco', () => {
  it('a base do kit passa: todas as datas em YYYY-MM-DD', async () => {
    const payments = await bankOver(kitTables().kit_pagamentos!).listPayments();
    expect(payments).toHaveLength(9);
  });

  for (const bad of ['02/11/2026', '2026-11-31', '2026-2-1', '']) {
    it(`recusa a data ${JSON.stringify(bad)}`, async () => {
      const [first, ...rest] = kitTables().kit_pagamentos!;
      await expect(bankOver([{ ...first, data: bad }, ...rest]).listPayments()).rejects.toBeInstanceOf(SupabaseRestError);
    });
  }
});
