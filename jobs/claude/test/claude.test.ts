// Testes da chamada ao Claude pelo Agent SDK, com o query() falso (#66).
import { describe, expect, it } from 'vitest';
import { ClaudeError, createAsk, DEFAULT_MODEL, type QueryFn } from '../src/claude.ts';

const SCHEMA = { type: 'object', properties: { match: { type: ['string', 'null'] } }, required: ['match'] };

function fakeQuery(messages: unknown[]): { query: QueryFn; params: unknown[] } {
  const params: unknown[] = [];
  const query: QueryFn = (p) => {
    params.push(p);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
  return { query, params };
}

describe('createAsk (#66)', () => {
  it('pede saída estruturada, sem ferramentas e numa sessão isolada', async () => {
    const { query, params } = fakeQuery([{ type: 'result', subtype: 'success', structured_output: { match: 'x' } }]);
    const ask = createAsk(query);
    await expect(ask({ system: 'sistema', prompt: 'pergunta', schema: SCHEMA })).resolves.toEqual({ match: 'x' });
    expect(params[0]).toMatchObject({
      prompt: 'pergunta',
      options: {
        systemPrompt: 'sistema',
        model: DEFAULT_MODEL,
        tools: [],
        allowedTools: [],
        settingSources: [],
        persistSession: false,
        outputFormat: { type: 'json_schema', schema: SCHEMA },
      },
    });
  });

  it('usa o modelo pedido', async () => {
    const { query, params } = fakeQuery([{ type: 'result', subtype: 'success', structured_output: {} }]);
    await createAsk(query)({ system: 's', prompt: 'p', schema: SCHEMA, model: 'outro-modelo' });
    expect((params[0] as { options: { model: string } }).options.model).toBe('outro-modelo');
  });

  it('resultado de erro vira ClaudeError com o subtipo e sem o texto do modelo', async () => {
    const { query } = fakeQuery([
      { type: 'result', subtype: 'error_max_structured_output_retries', errors: ['texto com dados'] },
    ]);
    const error = await createAsk(query)({ system: 's', prompt: 'p', schema: SCHEMA }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeError);
    expect((error as Error).message).toContain('error_max_structured_output_retries');
    expect((error as Error).message).not.toContain('texto com dados');
  });

  it('sucesso sem saída estruturada é erro', async () => {
    const { query } = fakeQuery([{ type: 'result', subtype: 'success', result: 'oi' }]);
    await expect(createAsk(query)({ system: 's', prompt: 'p', schema: SCHEMA })).rejects.toBeInstanceOf(ClaudeError);
  });

  it('sucesso marcado com is_error é erro', async () => {
    const { query } = fakeQuery([{ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate' }]);
    const error = await createAsk(query)({ system: 's', prompt: 'p', schema: SCHEMA }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeError);
    expect((error as Error).message).not.toContain('authenticate');
  });

  it('sessão que termina sem resultado é erro', async () => {
    const { query } = fakeQuery([{ type: 'assistant' }]);
    await expect(createAsk(query)({ system: 's', prompt: 'p', schema: SCHEMA })).rejects.toBeInstanceOf(ClaudeError);
  });
});
