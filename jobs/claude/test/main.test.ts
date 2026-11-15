// Testes do laço do executor: pula o que já está ok, registra erro e segue, limita a 50 (#66).
import { describe, expect, it } from 'vitest';
import type { Ask } from '../src/claude.ts';
import { DEFAULT_MODEL } from '../src/claude.ts';
import { readConfig, runTasks, selectTasks } from '../src/main.ts';
import type { Db, Row, UpsertOptions } from '../src/supabase.ts';
import type { ClaudeTask } from '../src/task.ts';

type Upsert = { table: string; rows: readonly Row[]; options: UpsertOptions };

function fakeDb(existing: Row[]): { db: Db; upserts: Upsert[]; selects: unknown[] } {
  const upserts: Upsert[] = [];
  const selects: unknown[] = [];
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

function task(keys: string[], run: ClaudeTask<{ n: string }, { r: string }>['run']): ClaudeTask<{ n: string }, { r: string }> {
  return {
    name: 'teste',
    pending: async () => keys.map((key) => ({ key, input: { n: key } })),
    run,
  };
}

describe('runTasks (#66)', () => {
  it('pula as chaves que já estão ok e grava as novas com ignore-duplicates', async () => {
    const { db, upserts, selects } = fakeDb([{ input_key: 'a', status: 'ok' }]);
    const lines: string[] = [];
    await runTasks({ db, ask: noAsk, tasks: [task(['a', 'b'], async (i) => ({ r: i.n }))], log: (l) => lines.push(l) });
    expect(selects[0]).toMatchObject({ table: 'claude_suggestions', options: { filters: { task: 'eq.teste' } } });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      table: 'claude_suggestions',
      rows: [{ task: 'teste', input_key: 'b', input: { n: 'b' }, output: { r: 'b' }, status: 'ok', model: DEFAULT_MODEL, error: null }],
      options: { onConflict: 'task,input_key', resolution: 'ignore' },
    });
    expect(lines).toEqual(['tarefa teste: 1 pendentes, ok 1, erro 0']);
  });

  it('refaz a chave que ficou em erro, atualizando a linha (merge-duplicates)', async () => {
    const { db, upserts } = fakeDb([{ input_key: 'a', status: 'erro' }]);
    await runTasks({ db, ask: noAsk, tasks: [task(['a'], async (i) => ({ r: i.n }))], log: () => {} });
    expect(upserts[0]).toMatchObject({ rows: [{ input_key: 'a', status: 'ok' }], options: { resolution: 'merge' } });
  });

  it('a falha de um item vira linha de erro curta e o laço segue', async () => {
    const { db, upserts } = fakeDb([]);
    const lines: string[] = [];
    const longa = 'x'.repeat(500);
    await runTasks({
      db,
      ask: noAsk,
      tasks: [
        task(['a', 'b'], async (i) => {
          if (i.n === 'a') throw new TypeError(longa);
          return { r: i.n };
        }),
      ],
      log: (l) => lines.push(l),
    });
    expect(upserts).toHaveLength(2);
    const erro = upserts[0]!.rows[0]!;
    expect(erro).toMatchObject({ input_key: 'a', status: 'erro', output: null });
    expect(String(erro.error).startsWith('TypeError: ')).toBe(true);
    expect(String(erro.error).length).toBeLessThanOrEqual('TypeError: '.length + 200);
    expect(upserts[1]!.rows[0]).toMatchObject({ input_key: 'b', status: 'ok' });
    expect(lines).toEqual(['tarefa teste: 2 pendentes, ok 1, erro 1']);
  });

  it('a mensagem de erro não leva segredo', async () => {
    const { db, upserts } = fakeDb([]);
    await runTasks({
      db,
      ask: noAsk,
      secrets: ['segredo-do-token'],
      tasks: [
        task(['a'], async () => {
          throw new Error('falhou com segredo-do-token no meio');
        }),
      ],
      log: () => {},
    });
    expect(String(upserts[0]!.rows[0]!.error)).not.toContain('segredo-do-token');
  });

  it('roda no máximo 50 por tarefa por vez', async () => {
    const { db, upserts } = fakeDb([]);
    const keys = Array.from({ length: 60 }, (_, i) => `k${i}`);
    const lines: string[] = [];
    await runTasks({ db, ask: noAsk, tasks: [task(keys, async (i) => ({ r: i.n }))], log: (l) => lines.push(l) });
    expect(upserts).toHaveLength(50);
    expect(lines).toEqual(['tarefa teste: 60 pendentes, ok 50, erro 0']);
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
    });
    expect(seen).toEqual([{ r: 'do-claude' }]);
  });

  it('a falha de uma tarefa inteira não impede a próxima e é devolvida', async () => {
    const { db, upserts } = fakeDb([]);
    const quebrada: ClaudeTask<unknown, unknown> = {
      name: 'quebrada',
      pending: async () => {
        throw new Error('sem tabela');
      },
      run: async () => ({}),
    };
    const lines: string[] = [];
    const result = await runTasks({ db, ask: noAsk, tasks: [quebrada, task(['a'], async (i) => ({ r: i.n }))], log: (l) => lines.push(l) });
    expect(result.failedTasks).toEqual(['quebrada']);
    expect(upserts).toHaveLength(1);
    expect(lines[0]).toMatch(/^tarefa quebrada: falhou/);
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
