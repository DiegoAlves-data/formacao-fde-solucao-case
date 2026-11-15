import { describe, expect, it } from 'vitest';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #64 / #33: o E7 contra o mock do Banco (kit_pagamentos), pelo Cron de captura de ponta a ponta.
// #64: os 9 pagamentos sem nota da base do kit, cada um com a nota tardia que fecha com ele
// #64: (fornecedor, destino, valor; emitida de 4 a 8 dias depois). Final da chave → pagamento.
const LATE_INVOICE_TO_PAYMENT: Record<string, string> = {
  '74374841': 'PG-5301',
  '79888508': 'PG-5304',
  '41877330': 'PG-5308',
  '48705738': 'PG-5314',
  '40738771': 'PG-5317',
  '59805593': 'PG-5322',
  '75916188': 'PG-5325',
  '76905480': 'PG-5330',
  '43275618': 'PG-5337',
};

type Row = Record<string, unknown>;

describe('#64 E7 pago fora do fluxo na base do kit (offline)', () => {
  const captured = async () => {
    const fake = new FakePostgrest(kitTables());
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
    await captureInvoices(supabaseConnectors(rest).captureDeps);
    return fake;
  };

  it('AC-1 (regra 2): as 9 notas tardias da base saem E7, e nenhuma outra', async () => {
    const fake = await captured();
    const e7 = (fake.rows('invoices') as Row[])
      .filter((r) => r.classification === 'E7')
      .map((r) => String(r.access_key).slice(-8))
      .sort();
    expect(e7).toEqual(Object.keys(LATE_INVOICE_TO_PAYMENT).sort());
  });

  it('AC-2 / AC-5 (regra 6): cada nota E7 fica gravada vinculada ao seu pagamento, como evidência do banco', async () => {
    const fake = await captured();
    const e7 = (fake.rows('divergences') as Row[]).filter((d) => d.classification === 'E7');
    expect(e7).toHaveLength(9);
    for (const d of e7) {
      const expected = LATE_INVOICE_TO_PAYMENT[String(d.invoice_access_key).slice(-8)];
      expect(d.evidence).toEqual([expect.objectContaining({ source: 'banco', reference: expected })]);
    }
  });
});
