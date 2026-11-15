// #130 Os pedidos do dossiê feitos na gaveta, em dossier_requests. Servem ao 409 (geração em andamento),
// ao 429 (limite por proposta) e ao estado `generating` que a gaveta lê enquanto o Claude trabalha.
import { isString, nullable, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';

const TABLE = 'dossier_requests';

/** #130 Um pedido sem finished_at há menos que isto é geração em andamento; mais velho, abandonado. */
export const IN_FLIGHT_MS = 5 * 60_000;
/** #130 A janela do limite por proposta. */
export const LIMIT_WINDOW_MS = 60 * 60_000;
/** #130 Pedidos aceitos por proposta na janela; o seguinte recebe 429. */
export const MAX_REQUESTS_PER_WINDOW = 3;

/** #130 Um pedido como a tabela o guarda. */
export type DossierRequest = {
  readonly input_key: string;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly finished_at: string | null;
};

/** #130 A porta dos pedidos; os testes usam o FakePostgrest por trás da implementação do Supabase. */
export interface DossierRequests {
  /** #130 Os pedidos da nota feitos desde `since`, do mais novo ao mais velho. */
  since(invoiceAccessKey: string, since: Date): Promise<DossierRequest[]>;
  /** #130 #38 AC-6 Os pedidos ainda abertos de todas as notas, feitos desde `since`: uma leitura só, para o Cron. */
  openSince(since: Date): Promise<DossierRequest[]>;
  /** #130 Registra o pedido aceito. */
  open(request: Omit<DossierRequest, 'finished_at'>): Promise<void>;
  /** #130 Fecha os pedidos ainda abertos da nota, com sucesso ou não. */
  finish(invoiceAccessKey: string, at: Date): Promise<void>;
}

/** #130 O pedido em andamento da nota, se houver: aberto e com menos de IN_FLIGHT_MS. */
export function inFlight(requests: readonly DossierRequest[], now: Date): DossierRequest | undefined {
  return requests.find((r) => r.finished_at === null && now.getTime() - Date.parse(r.requested_at) < IN_FLIGHT_MS);
}

const isRequest = shaped<DossierRequest>({
  input_key: isString,
  requested_by: isString,
  requested_at: isString,
  finished_at: nullable(isString),
} satisfies Shape<DossierRequest>);

/** #130 dossier_requests pelo PostgREST. A chave chega aqui já validada pela rota (ACCESS_KEY). */
export class SupabaseDossierRequests implements DossierRequests {
  constructor(private readonly rest: SupabaseRest) {}

  async since(invoiceAccessKey: string, since: Date): Promise<DossierRequest[]> {
    const rows = await this.rest.select(TABLE, {
      select: 'input_key,requested_by,requested_at,finished_at',
      filters: { input_key: `eq.${invoiceAccessKey}`, requested_at: `gte.${since.toISOString()}` },
      order: 'requested_at.desc',
    });
    return parseRows(rows, isRequest, TABLE);
  }

  async openSince(since: Date): Promise<DossierRequest[]> {
    const rows = await this.rest.select(TABLE, {
      select: 'input_key,requested_by,requested_at,finished_at',
      filters: { finished_at: 'is.null', requested_at: `gte.${since.toISOString()}` },
      order: 'requested_at.desc',
    });
    return parseRows(rows, isRequest, TABLE);
  }

  async open(request: Omit<DossierRequest, 'finished_at'>): Promise<void> {
    await this.rest.insert(TABLE, [{ ...request, finished_at: null }], { ignoreDuplicates: false });
  }

  async finish(invoiceAccessKey: string, at: Date): Promise<void> {
    await this.rest.update(TABLE, { input_key: `eq.${invoiceAccessKey}`, finished_at: 'is.null' }, { finished_at: at.toISOString() });
  }
}
