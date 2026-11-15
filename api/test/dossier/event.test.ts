/**
 * #38 O agente do dossiê disparado pelo evento: a proposta que acabou de virar `aguardando_aprovacao` ganha o
 * dossiê sozinha, sem rodada agendada (AC-1). Os testes chamam `generateOnEvent` direto, como o `tick` chama
 * pelo `defer` (cron/tick.ts) — sem laço de tarefas, sem `pending()` relendo o estado da tabela.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClaudeError, type Ask } from '../../src/claude/client.js';
import { restDb } from '../../src/claude/db.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { generateOnEvent } from '../../src/dossier/event.js';
import { readDossier } from '../../src/dossier/read-dossier.js';
import { SupabaseDossierSource } from '../../src/dossier/source.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { KIT_ACCESS_KEY, kitCase, kitGoodRaw } from './kit-case.js';

const answering = (output: unknown) => vi.fn(async () => output) as unknown as Ask & ReturnType<typeof vi.fn>;

async function setup(suggestions: Record<string, unknown>[] = []) {
  const { invoice, ctx, tables } = await kitCase();
  const fake = new FakePostgrest({ ...tables, claude_suggestions: suggestions });
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const db = restDb(rest);
  const context = vi.fn(async () => ctx);
  const gaveta = () =>
    readDossier({
      invoiceAccessKey: KIT_ACCESS_KEY,
      invoice,
      loadContext: async () => ctx,
      source: new SupabaseDossierSource(rest),
    });
  const run = (ask: Ask) => generateOnEvent({ db, ask, context }, invoice);
  return { invoice, ctx, fake, db, context, run, gaveta };
}

const sugestoes = (fake: FakePostgrest) => fake.tables.get('claude_suggestions') ?? [];

describe('#38 do evento à gaveta, sem rodada agendada', () => {
  it('AC-1 a proposta registrada ganha o dossiê na hora, e a gaveta mostra pronto', async () => {
    const { run, gaveta, fake, context } = await setup();
    const ask = answering(kitGoodRaw());
    await run(ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(context).toHaveBeenCalledTimes(1);
    const rows = sugestoes(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: 'dossier', input_key: KIT_ACCESS_KEY, status: 'ok', trigger: 'event' });
    expect((await gaveta())?.status).toBe('ready');
  });

  it('AC-6 um segundo disparo para a mesma nota não chama o Claude nem relê o contexto', async () => {
    const { run, fake, context } = await setup();
    await run(answering(kitGoodRaw()));
    const again = answering(kitGoodRaw());
    await run(again);
    expect(again).not.toHaveBeenCalled();
    expect(context).toHaveBeenCalledTimes(1);
    expect(sugestoes(fake)).toHaveLength(1);
  });

  it('AC-6 já existe uma linha (de um pedido na gaveta, #130): o evento não dispara', async () => {
    const existing = [
      {
        task: 'dossier',
        input_key: KIT_ACCESS_KEY,
        input: {},
        output: null,
        status: 'generating',
        error: null,
        attempts: 0,
        model: 'claude-haiku',
        updated_at: new Date().toISOString(),
        trigger: 'on_demand',
      },
    ];
    const { run, fake, context } = await setup(existing);
    await run(answering(kitGoodRaw()));
    expect(sugestoes(fake)).toHaveLength(1);
    expect(sugestoes(fake)[0]).toMatchObject({ trigger: 'on_demand', status: 'generating' });
    expect(context).not.toHaveBeenCalled();
  });

  it('AC-3 um número escrito fora de um marcador deixa o dossiê indisponível na gaveta', async () => {
    const { run, gaveta } = await setup();
    await run(answering({ ...kitGoodRaw(), summary: 'A nota cobra 88 UN do leite.' }));
    expect(await gaveta()).toMatchObject({ status: 'unavailable', reason: 'number_mismatch' });
  });

  it('AC-5 a falha do Claude grava o erro, e a gaveta mostra o dossiê indisponível', async () => {
    const { run, gaveta, fake } = await setup();
    await run(vi.fn(async () => { throw new Error('caiu'); }) as unknown as Ask);
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'error', output: null, trigger: 'event', reason: 'claude_failed' });
    expect(await gaveta()).toMatchObject({ status: 'unavailable', reason: 'claude_failed' });
  });

  it('AC-5 o prazo vencido vira o motivo timeout', async () => {
    const { run, fake } = await setup();
    await run(vi.fn(async () => { throw new ClaudeError('timeout', 'sem resposta'); }) as unknown as Ask);
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'error', trigger: 'event', reason: 'timeout' });
  });

  it('AC-2 a resposta fora do formato grava o erro de formato, não um erro inesperado', async () => {
    const { run, fake } = await setup();
    await run(answering({ summary: 'x' }));
    const [row] = sugestoes(fake);
    expect(row).toMatchObject({ status: 'error', output: null, attempts: 1, reason: 'invalid_shape' });
    expect(String(row?.error)).toMatch(/^ClaudeError:/);
  });

  it('AC-5 sem credencial (sem `ask`), grava claude_failed e nunca lança', async () => {
    const { fake, db, context, invoice } = await setup();
    await expect(generateOnEvent({ db, context }, invoice)).resolves.toBeUndefined();
    expect(sugestoes(fake)[0]).toMatchObject({ status: 'error', trigger: 'event', reason: 'claude_failed' });
  });

  it('AC-4 o dossiê não toca na proposta', async () => {
    const { run, fake } = await setup();
    const before = JSON.stringify(fake.tables.get('proposals') ?? []);
    await run(answering(kitGoodRaw()));
    expect(JSON.stringify(fake.tables.get('proposals') ?? [])).toBe(before);
  });

  it('nunca lança para fora, mesmo se a escrita final falhar', async () => {
    const { ctx, invoice } = await kitCase();
    const db = {
      select: vi.fn(async () => []),
      upsert: vi.fn(async () => { throw new Error('banco fora do ar'); }),
    };
    await expect(generateOnEvent({ db, ask: answering(kitGoodRaw()), context: async () => ctx }, invoice)).resolves.toBeUndefined();
  });
});
