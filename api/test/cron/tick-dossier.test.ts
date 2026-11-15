/**
 * #38 AC-1: o dossiê dispara sozinho na mesma rodada que propõe, sem rodada agendada — não é uma tarefa do
 * laço (#66/#171), que relê o estado da tabela a cada tick. Os testes rodam o `tick` de ponta a ponta sobre a
 * base do kit, com `defer` coletando o que seria o `waitUntil` do Worker, para poder esperar o resultado.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tasksFor } from '../../src/claude/tasks/index.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { DOSSIER_EVENT_LIMIT, tick } from '../../src/cron/tick.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

const ENV: Env = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
const WITH_CLAUDE: Env = { ...ENV, BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token' };

/** #171 Resposta mínima e válida da Messages API: a tool `responder` com uma saída que passa no schema. */
function claudeAnswer() {
  return new Response(
    JSON.stringify({ content: [{ type: 'tool_use', name: 'responder', input: { summary: 'ok', divergences: [], supplier_history: 'ok' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Roteia a Messages API para a resposta fixa e o resto para o PostgREST falso da base do kit. */
function stubFetchWithClaude(fake: FakePostgrest): void {
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
    String(input).startsWith('https://api.anthropic.com/') ? claudeAnswer() : fake.fetch(String(input), init),
  );
}

async function runTick(env: Env, fake: FakePostgrest): Promise<void> {
  const deferred: Promise<unknown>[] = [];
  await tick({ cron: '*/15 * * * *' }, env, (work) => void deferred.push(work));
  await Promise.all(deferred);
  void fake; // a base já está gravada no fetch
}

const dossierRows = (fake: FakePostgrest) => fake.rows('claude_suggestions').filter((r) => r.task === 'dossier');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#38 o dossiê não é uma tarefa do laço do Claude', () => {
  it('tasksFor() não registra o dossiê: ele não faz parte da rodada agendada do #66/#171', () => {
    const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake' });
    expect(tasksFor(rest).map((t) => t.name)).not.toContain('dossier');
  });
});

describe('#38 AC-1: o tick dispara o dossiê das propostas que acabou de encaminhar a uma pessoa', () => {
  it('com a credencial do Claude, a rodada grava dossiês com trigger event, até o teto por rodada', async () => {
    const fake = new FakePostgrest(kitTables());
    stubFetchWithClaude(fake);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runTick(WITH_CLAUDE, fake);

    const rows = dossierRows(fake);
    expect(rows.length).toBe(DOSSIER_EVENT_LIMIT);
    expect(rows.every((r) => r.trigger === 'event' && r.status === 'ok')).toBe(true);
  });

  it('AC-5: sem a credencial do Claude, a rodada não grava nenhum dossiê, e a proposta segue sem ele', async () => {
    const fake = new FakePostgrest(kitTables());
    vi.stubGlobal('fetch', fake.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runTick(ENV, fake);

    expect(dossierRows(fake)).toHaveLength(0);
  });

  it('AC-6: a segunda rodada não repete o dossiê das propostas da primeira, só as novas (nenhuma aqui)', async () => {
    const fake = new FakePostgrest(kitTables());
    stubFetchWithClaude(fake);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runTick(WITH_CLAUDE, fake);
    const afterFirst = dossierRows(fake).length;
    await runTick(WITH_CLAUDE, fake);

    // #63 A segunda rodada não propõe de novo (restrição única), então não há proposta nova para disparar.
    expect(dossierRows(fake)).toHaveLength(afterFirst);
  });
});
