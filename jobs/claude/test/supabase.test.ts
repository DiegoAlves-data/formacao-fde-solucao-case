// Testes do cliente mínimo do PostgREST do executor do Claude (#66).
import { describe, expect, it } from 'vitest';
import { SupabaseClient, SupabaseError, type FetchFn } from '../src/supabase.ts';

const KEY = 'sb_secret_chave-que-nao-pode-vazar';
const URL_BASE = 'https://exemplo.supabase.co';

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(responses: Response[]): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('sem resposta preparada');
    return next;
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('SupabaseClient (#66)', () => {
  it('select monta filtros, ordem e colunas e manda a chave só no apikey', async () => {
    const { fetch, calls } = fakeFetch([json([{ input_key: 'a' }])]);
    const db = new SupabaseClient({ url: `${URL_BASE}/`, secretKey: KEY, fetch });
    const rows = await db.select('claude_suggestions', {
      select: 'input_key,status',
      filters: { task: 'eq.description-match' },
      order: 'input_key.asc',
    });
    expect(rows).toEqual([{ input_key: 'a' }]);
    const call = calls[0]!;
    const url = new URL(call.url);
    expect(url.pathname).toBe('/rest/v1/claude_suggestions');
    expect(url.searchParams.get('select')).toBe('input_key,status');
    expect(url.searchParams.get('task')).toBe('eq.description-match');
    expect(url.searchParams.get('order')).toBe('input_key.asc');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.apikey).toBe(KEY);
    expect(headers.Authorization).toBeUndefined();
  });

  it('select pagina pelo Range até a página vir incompleta', async () => {
    const { fetch, calls } = fakeFetch([json([{ n: 1 }, { n: 2 }]), json([{ n: 3 }])]);
    const db = new SupabaseClient({ url: URL_BASE, secretKey: KEY, fetch, pageSize: 2 });
    const rows = await db.select('kit_produtos');
    expect(rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect((calls[0]!.init?.headers as Record<string, string>).Range).toBe('0-1');
    expect((calls[1]!.init?.headers as Record<string, string>).Range).toBe('2-3');
  });

  it('upsert manda on_conflict e a resolução pedida no Prefer', async () => {
    const { fetch, calls } = fakeFetch([json([]), json([])]);
    const db = new SupabaseClient({ url: URL_BASE, secretKey: KEY, fetch });
    await db.upsert('claude_suggestions', [{ task: 't' }], { onConflict: 'task,input_key', resolution: 'ignore' });
    await db.upsert('claude_suggestions', [{ task: 't' }], { onConflict: 'task,input_key', resolution: 'merge' });
    expect(new URL(calls[0]!.url).searchParams.get('on_conflict')).toBe('task,input_key');
    expect(calls[0]!.init?.method).toBe('POST');
    expect((calls[0]!.init?.headers as Record<string, string>).Prefer).toContain('resolution=ignore-duplicates');
    expect((calls[1]!.init?.headers as Record<string, string>).Prefer).toContain('resolution=merge-duplicates');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual([{ task: 't' }]);
  });

  it('o erro HTTP não leva a chave nem o corpo da resposta', async () => {
    const corpo = `falhou com ${KEY} e dados sensíveis`;
    const { fetch } = fakeFetch([new Response(corpo, { status: 401 })]);
    const db = new SupabaseClient({ url: URL_BASE, secretKey: KEY, fetch });
    const error = await db.select('kit_notas').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseError);
    const message = (error as Error).message;
    expect(message).toContain('401');
    expect(message).toContain('kit_notas');
    expect(message).not.toContain(KEY);
    expect(message).not.toContain('sensíveis');
  });

  it('a falha de rede não leva a chave nem a mensagem original', async () => {
    const fetch: FetchFn = async () => {
      throw new Error(`conexão recusada ${KEY}`);
    };
    const db = new SupabaseClient({ url: URL_BASE, secretKey: KEY, fetch });
    const error = await db.select('kit_notas').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseError);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('a chave legada (JWT) vai também no Authorization', async () => {
    const { fetch, calls } = fakeFetch([json([])]);
    const db = new SupabaseClient({ url: URL_BASE, secretKey: 'eyJ.legada', fetch });
    await db.select('kit_notas');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer eyJ.legada');
  });
});
