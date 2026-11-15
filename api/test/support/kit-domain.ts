// O kit (data/kit/*.json) lido como objetos do domínio, pelos mesmos conectores do Cron (#66).
import { readFileSync } from 'node:fs';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { Invoice, type CheckContext, type InvoiceItem } from '../../src/domain/index.js';
import { FakePostgrest } from './fake-postgrest.js';
import { kitTables } from './kit.js';

export type KitDomain = {
  readonly invoices: readonly Invoice[];
  /** #66 O contexto com o cadastro do kit (fornecedores e produtos); o resto vazio. */
  readonly ctx: CheckContext;
};

/** #66 Lê as notas e o cadastro do kit pelos conectores, sobre o PostgREST falso. */
export async function kitDomain(): Promise<KitDomain> {
  const rest = new SupabaseRest({
    url: 'https://fake.supabase.co',
    secretKey: 'sb_secret_fake',
    fetch: new FakePostgrest(kitTables()).fetch,
  });
  const { captureDeps } = supabaseConnectors(rest);
  const [invoices, suppliers, products] = await Promise.all([
    captureDeps.sefaz.listIssuedInvoices(),
    captureDeps.registry.listSuppliers(),
    captureDeps.registry.listProducts(),
  ]);
  return {
    invoices,
    ctx: {
      purchaseOrders: [],
      suppliers,
      products,
      postedInvoices: [],
      payments: [],
      receipts: [],
      capturedInvoices: [],
    },
  };
}

const kitNotes = JSON.parse(
  readFileSync(new URL('../../../data/kit/notas.json', import.meta.url), 'utf8'),
) as { nota_id: string; chave: string }[];

/** #66 A nota do kit pelo id dela (NF-009), como o domínio a recebe. */
export function kitInvoice(kit: KitDomain, invoiceId: string): Invoice {
  const accessKey = kitNotes.find((n) => n.nota_id === invoiceId)?.chave;
  const invoice = kit.invoices.find((i) => i.accessKey === accessKey);
  if (!invoice) throw new Error(`kit: nota ${invoiceId} não encontrada`);
  return invoice;
}

/** #66 Uma cópia da nota com os itens trocados (o total segue o da nota original). */
export function withItems(invoice: Invoice, items: readonly InvoiceItem[]): Invoice {
  return Invoice.receive({
    accessKey: invoice.accessKey,
    number: invoice.number,
    series: invoice.series,
    supplierId: invoice.supplierId,
    store: invoice.store,
    issuedOn: invoice.issuedOn,
    purchaseOrderRef: invoice.purchaseOrderRef,
    entryChannel: invoice.entryChannel,
    items,
    total: invoice.total,
  });
}
