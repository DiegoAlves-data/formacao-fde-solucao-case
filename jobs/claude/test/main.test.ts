/**
 * Testes do laço do executor (#66): pula o que já está ok, registra erro e segue, limita a 50,
 * retenta com teto e espera, e nunca grava o texto de um erro que não é nosso.
 */
import { describe, expect, it } from 'vitest';
import type { Ask } from '../src/claude.ts';
import { ClaudeError, DEFAULT_MODEL } from '../src/claude.ts';
import { MAX_ATTEMPTS, readConfig, runTasks, selectTasks } from '../src/main.ts';
import type { Db, Row, SelectOptions, UpsertOptions } from '../src/supabase.ts';
import { SupabaseError } from '../src/supabase.ts';
import type { ClaudeTask } from '../src/task.ts';

type Upsert = { table: string; rows: readonly Row[]; options: UpsertOptions };

const NOW = new Date('2026-11-15T12:00:00Z');
const MINUTES = 60_000;
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * MINUTES).toISOString();
const clock = (): Date => NOW;

function fakeDb(existing: unknown[]): { db: Db; upserts: Upsert[]; selects: { table: string; options: SelectOptions }[] } {
  const upserts: Upsert[] = [];
  const selects: { table: string; options: SelectOptions }[] = [];
  const db: Db = {
    select: async (table, options) => {
      selects.push({ table, options });
      return table === 'claude_suggestions' ? existing : [];
    },
    upsert: async (table, rows, options) => {
      upserts.push({ table, rows, options });
      return [];
    },
  };
  return { db, upserts, selects };
}

const noAsk: Ask = async () => {
  throw new Error('não deveria chamar o Claude');
};

function task(keys: string[], run: ClaudeTask<{ n: string }, { r: string }>['run'], dropped = 0): ClaudeTask<{ n: string }, { r: string }> {
  return {
    name: 'teste',
    pending: async () => ({ requests: keys.map((key) => ({ key, input: { n: key } })), dropped }),
    run,
  };
}

const echo = async (i: { n: string }) => ({ r: i.n });
const stored = (key: string, status: string, attempts: number, minutesAgo: number): Row => ({
  input_key: key,
  status,
  attempts,
  updated_at: ago(minutesAgo),
});

describe('runTasks (#66)', () => {
  it('pula as chaves que já estão ok e grava as novas com ignore-duplicates, lendo com ordem explícita', async () => {
    const { db, upserts, selects } = fakeDb([stored('a', 'ok', 0, 1)]);
    const lines: string[] = [];
    await runTasks({ db, ask: noAsk, tasks: [task(['a', 'b'], echo)], log: (l) => lines.push(l), now: clock });
    expect(selects[0]).toMatchObject({
      table: 'claude_suggestions',
      options: { filters: { task: 'eq.teste' }, order: 'input_key.asc' },
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      table: 'claude_suggestions',
      rows: [
        {
          task: 'teste',
          input_key: 'b',
          input: { n: 'b' },
          output: { r: 'b' },
          status: 'ok',
          model: DEFAULT_MODEL,
          error: null,
          attempts: 0,
          updated_at: NOW.toISOString(),
        },
      ],
      options: { onConflict: 'task,input_key', resolution: 'ignore' },
    });
    expect(lines).toEqual(['tarefa teste: 1 pendentes, ok 1, erro 0']);
  });

  it('refaz a chave que ficou em erro depois da espera, atualizando a linha (merge-duplicates)', async () => {
    const { db, upserts } = fakeDb([stored('a', 'error', 1, 11)]);
    await runTasks({ db, ask: noAsk, tasks: [task(['a'], echo)], log: () => {}, now: clock });
    expect(upserts[0]).toMatchObject({ rows: [{ input_key: 'a', status: 'ok', attempts: 1 }], options: { resolution: 'merge' } });
  });

  it('pula a chave em erro que ainda está na espera de 5 min * 2^tentativas', async () => {
    const { db, upserts } = fakeDb([stored('a', 'error', 1, 9), stored('b', 'error', 2, 19), stored('c', 'error', 0, 4)]);
    const lines: string[] = [];
    await runTasks({ db, ask: noAsk, tasks: [task(['a', 'b', 'c'], echo)], log: (l) => lines.push(l), now: clock });
    expect(upserts).toHaveLength(0);
    expect(lines[0]).toContain('em espera 3');
  });

  it('tenta a chave em erro cuja espera já passou, e pula a que chegou ao teto de tentativas', async () => {
    const { db, upserts } = fakeDb([stored('a', 'error', 2, 21), stored('b', 'error', MAX_ATTEMPTS, 100_000)]);
    await runTasks({ db, ask: noAsk, tasks: [task(['a', 'b'], echo)], log: () => {}, now: clock });
    expect(MAX_ATTEMPTS).toBe(3);
    expect(upserts.map((u) => u.rows[0]!.input_key)).toEqual(['a']);
  });

  it('a falha de um item vira linha de erro com mais uma tentativa e o laço segue', async () => {
    const { db, upserts } = fakeDb([stored('a', 'error', 1, 11)]);
    const lines: string[] = [];
    const long = 'x'.repeat(500);
    await runTasks({
      db,
      ask: noAsk,
      tasks: [
        task(['a', 'b'], async (i) => {
          if (i.n === 'a') throw new ClaudeError(long);
          return { r: i.n };
        }),
      ],
      log: (l) => lines.push(l),
      now: clock,
    });
    expect(upserts).toHaveLength(2);
    const failed = upserts.find((u) => u.rows[0]!.input_key === 'a')!.rows[0]!;
    expect(failed).toMatchObject({ status: 'error', output: null, attempts: 2, updated_at: NOW.toISOString() });
    expect(String(failed.error).startsWith('ClaudeError: claude: ')).toBe(true);
    expect(String(failed.error).length).toBeLessThanOrEqual('ClaudeError: '.length + 200);
    expect(upserts.find((u) => u.rows[0]!.input_key === 'b')!.rows[0]).toMatchObject({ status: 'ok', attempts: 0 });
    expect(lines[0]).toMatch(/^tarefa teste: 2 pendentes, ok 1, erro 1, primeiro erro: ClaudeError: claude: x+$/);
  });

  it('pede primeiro as chaves nunca tentadas, depois as que erraram, e o teto de 50 vale depois da ordem', async () => {
    const failing = Array.from({ length: 50 }, (_, i) => `e${i}`);
    const { db, upserts } = fakeDb(failing.map((key) => stored(key, 'error', 1, 60)));
    await runTasks({ db, ask: noAsk, tasks: [task([...failing, 'novo'], echo)], log: () => {}, now: clock });
    expect(upserts).toHaveLength(50);
    expect(upserts[0]!.rows[0]!.input_key).toBe('novo');
    expect(upserts.at(-1)!.rows[0]!.input_key).toBe('e48');
  });

  it('roda no máximo 50 por tarefa por vez', async () => {
    const { db, upserts } = fakeDb([]);
    const keys = Array.from({ length: 60 }, (_, i) => `k${i}`);
    const lines: string[] = [];
    await runTasks({ db, ask: noAsk, tasks: [task(keys, echo)], log: (l) => lines.push(l), now: clock });
    expect(upserts).toHaveLength(50);
    expect(lines).toEqual(['tarefa teste: 60 pendentes, ok 50, erro 0']);
  });

  it('a tarefa em que nenhum item deu certo e algum falhou conta como falha', async () => {
    const { db } = fakeDb([]);
    const failAll = async (): Promise<{ r: string }> => {
      throw new ClaudeError('resultado com is_error');
    };
    const result = await runTasks({ db, ask: noAsk, tasks: [task(['a', 'b'], failAll)], log: () => {}, now: clock });
    expect(result.failedTasks).toEqual(['teste']);
  });

  it('falha parcial não derruba a rodada', async () => {
    const { db } = fakeDb([]);
    const some = async (i: { n: string }): Promise<{ r: string }> => {
      if (i.n === 'a') throw new ClaudeError('x');
      return { r: i.n };
    };
    const result = await runTasks({ db, ask: noAsk, tasks: [task(['a', 'b'], some)], log: () => {}, now: clock });
    expect(result.failedTasks).toEqual([]);
  });

  it('a mensagem de erro nossa não leva segredo', async () => {
    const { db, upserts } = fakeDb([]);
    await runTasks({
      db,
      ask: noAsk,
      secrets: ['segredo-do-token'],
      tasks: [task(['a'], async () => { throw new SupabaseError('select', 'kit_notas', 500, 'com segredo-do-token no meio'); })],
      log: () => {},
      now: clock,
    });
    expect(String(upserts[0]!.rows[0]!.error)).toContain('SupabaseError');
    expect(String(upserts[0]!.rows[0]!.error)).not.toContain('segredo-do-token');
  });

  it('erro que não é nosso grava só a classe: o texto do SDK nunca chega à linha nem ao log', async () => {
    const { db, upserts } = fakeDb([]);
    const lines: string[] = [];
    class SpawnError extends Error {
      override name = 'SpawnError';
    }
    const leak = 'spawn falhou: stderr ... sk-ant-oat01-AbCdEf0123456789 ...';
    await runTasks({
      db,
      ask: noAsk,
      tasks: [task(['a'], async () => { throw new SpawnError(leak); })],
      log: (l) => lines.push(l),
      now: clock,
    });
    expect(upserts[0]!.rows[0]!.error).toBe('SpawnError: erro inesperado');
    expect(JSON.stringify(upserts)).not.toContain('sk-ant');
    expect(lines.join('\n')).not.toContain('sk-ant');
    expect(lines[0]).toContain('primeiro erro: SpawnError: erro inesperado');
  });

  it('o que se lança e não é Error também não vaza', async () => {
    const { db, upserts } = fakeDb([]);
    await runTasks({
      db,
      ask: noAsk,
      tasks: [task(['a'], async () => { throw 'sk-ant-oat01-solto'; })],
      log: () => {},
      now: clock,
    });
    expect(JSON.stringify(upserts)).not.toContain('sk-ant');
  });

  it('linhas de claude_suggestions fora do formato são descartadas e contadas no log', async () => {
    const { db } = fakeDb([stored('a', 'ok', 0, 1), { input_key: 'b' }, null, { ...stored('c', 'ok', 0, 1), attempts: 'x' }]);
    const lines: string[] = [];
    await runTasks({ db, ask: noAsk, tasks: [task(['a'], echo, 2)], log: (l) => lines.push(l), now: clock });
    expect(lines).toEqual(['tarefa teste: 0 pendentes, ok 0, erro 0, linhas descartadas 5']);
  });

  it('passa o ask para o run da tarefa', async () => {
    const { db } = fakeDb([]);
    const ask: Ask = async <T>() => ({ r: 'do-claude' }) as T;
    const seen: unknown[] = [];
    await runTasks({
      db,
      ask,
      tasks: [
        task(['a'], async (_i, a) => {
          const out = await a<{ r: string }>({ system: 's', prompt: 'p', schema: {} });
          seen.push(out);
          return out;
        }),
      ],
      log: () => {},
      now: clock,
    });
    expect(seen).toEqual([{ r: 'do-claude' }]);
  });

  it('a falha de uma tarefa inteira não impede a próxima e é devolvida', async () => {
    const { db, upserts } = fakeDb([]);
    const broken: ClaudeTask<unknown, unknown> = {
      name: 'quebrada',
      pending: async () => {
        throw new Error('sem tabela');
      },
      run: async () => ({}),
    };
    const lines: string[] = [];
    const result = await runTasks({ db, ask: noAsk, tasks: [broken, task(['a'], echo)], log: (l) => lines.push(l), now: clock });
    expect(result.failedTasks).toEqual(['quebrada']);
    expect(upserts).toHaveLength(1);
    expect(lines[0]).toMatch(/^tarefa quebrada: falhou/);
    expect(lines[0]).not.toContain('sem tabela');
  });
});

describe('configuração do executor (#66)', () => {
  it('falta de variável é erro que nomeia a variável e não mostra valor', () => {
    expect(() => readConfig({ BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'segredo' })).toThrow(/BARTE_ACADEMY_SUPABASE_URL/);
    try {
      readConfig({ BARTE_ACADEMY_SUPABASE_URL: 'https://x.supabase.co' });
    } catch (e) {
      expect((e as Error).message).toMatch(/BARTE_ACADEMY_SUPABASE_SECRET_KEY/);
      expect((e as Error).message).not.toContain('x.supabase.co');
    }
  });

  it('lê as tarefas pedidas em CLAUDE_TASKS', () => {
    const config = readConfig({
      BARTE_ACADEMY_SUPABASE_URL: 'https://x.supabase.co',
      BARTE_ACADEMY_SUPABASE_SECRET_KEY: 's',
      CLAUDE_TASKS: ' description-match , ',
    });
    expect(config.tasks).toEqual(['description-match']);
  });

  it('sem CLAUDE_TASKS roda todas; nome desconhecido é erro', () => {
    expect(selectTasks([]).map((t) => t.name)).toContain('description-match');
    expect(() => selectTasks(['nao-existe'])).toThrow(/nao-existe/);
  });
});
