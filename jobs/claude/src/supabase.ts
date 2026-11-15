// Cliente mínimo do PostgREST do Supabase para o executor do Claude, com fetch puro (#66).
// Segue o estilo de api/src/connectors/supabase-rest.ts, sem importar de api/: os dois pacotes
// são independentes. O erro diz a operação, a tabela e o status; nunca a chave nem o corpo (#66).

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type Row = Record<string, unknown>;

/** #66 Filtros no formato do PostgREST: { coluna: 'eq.X' }. */
export type Filters = Readonly<Record<string, string>>;

export type SelectOptions = {
  readonly select?: string;
  readonly order?: string;
  readonly filters?: Filters;
};

export type UpsertOptions = {
  /** #66 Colunas da restrição única que decide a duplicada. */
  readonly onConflict: string;
  /** #66 ignore: a duplicada fica como está; merge: a duplicada é atualizada. */
  readonly resolution: 'ignore' | 'merge';
};

/** #66 O que as tarefas e o laço precisam do banco; os testes passam um falso. */
export interface Db {
  select(table: string, options?: SelectOptions): Promise<Row[]>;
  upsert(table: string, rows: readonly Row[], options: UpsertOptions): Promise<unknown[]>;
}

export type SupabaseConfig = {
  readonly url: string;
  readonly secretKey: string;
  readonly fetch?: FetchFn;
  /** #66 Linhas por página no select. */
  readonly pageSize?: number;
  /** #66 Tempo máximo de cada requisição, em milissegundos. */
  readonly timeoutMs?: number;
};

export type Operation = 'select' | 'upsert' | 'network' | 'parse';

/** #66 Falha do PostgREST, sem a chave e sem o corpo da resposta. */
export class SupabaseError extends Error {
  readonly operation: Operation;
  readonly table: string;
  readonly status: number;

  constructor(operation: Operation, table: string, status: number, detail = '') {
    super(`supabase: ${operation} em ${table} falhou (HTTP ${status}) ${detail}`.trim());
    this.name = 'SupabaseError';
    this.operation = operation;
    this.table = table;
    this.status = status;
  }
}

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

export class SupabaseClient implements Db {
  private readonly base: string;
  private readonly secretKey: string;
  private readonly doFetch: FetchFn;
  private readonly pageSize: number;
  private readonly timeoutMs: number;

  constructor(config: SupabaseConfig) {
    this.base = config.url.replace(/\/+$/, '') + '/rest/v1/';
    this.secretKey = config.secretKey;
    this.doFetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** #66 Lê todas as linhas que passam nos filtros, página a página pelo Range. */
  async select(table: string, options: SelectOptions = {}): Promise<Row[]> {
    const params = new URLSearchParams({ select: options.select ?? '*', ...options.filters });
    if (options.order) params.set('order', options.order);
    const rows: Row[] = [];
    for (let start = 0; ; start += this.pageSize) {
      const page = await this.request('select', table, 'GET', params, undefined, {
        'Range-Unit': 'items',
        Range: `${start}-${start + this.pageSize - 1}`,
      });
      rows.push(...(page as Row[]));
      if (page.length < this.pageSize) return rows;
    }
  }

  /** #66 Insere pela restrição de onConflict, ignorando ou atualizando a duplicada. */
  async upsert(table: string, rows: readonly Row[], options: UpsertOptions): Promise<unknown[]> {
    if (rows.length === 0) return [];
    const params = new URLSearchParams({ on_conflict: options.onConflict });
    const resolution = options.resolution === 'merge' ? 'merge-duplicates' : 'ignore-duplicates';
    return this.request('upsert', table, 'POST', params, rows, {
      Prefer: `return=minimal,resolution=${resolution}`,
    });
  }

  private async request(
    operation: Operation,
    table: string,
    method: string,
    params: URLSearchParams,
    body: unknown,
    extra: Record<string, string>,
  ): Promise<unknown[]> {
    const headers: Record<string, string> = { apikey: this.secretKey, 'Content-Type': 'application/json', ...extra };
    // #66 Chave nova (sb_...) vai só no apikey; a legada (JWT) também vai no Authorization.
    if (!this.secretKey.startsWith('sb_')) headers.Authorization = `Bearer ${this.secretKey}`;
    const query = params.toString();
    const url = `${this.base}${table}${query ? `?${query}` : ''}`;
    let response: Response;
    let text: string;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      // #66 A mensagem original pode trazer a URL ou cabeçalhos; fica só o tipo da falha.
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new SupabaseError('network', table, 0, timedOut ? `sem resposta em ${this.timeoutMs} ms` : 'falha de rede');
    }
    if (!response.ok) throw new SupabaseError(operation, table, response.status);
    if (!text) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SupabaseError('parse', table, response.status, 'a resposta não é JSON');
    }
    if (!Array.isArray(parsed)) throw new SupabaseError('parse', table, response.status, 'a resposta não é uma lista');
    return parsed;
  }
}
