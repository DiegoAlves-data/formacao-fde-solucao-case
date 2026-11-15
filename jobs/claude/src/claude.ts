// Chamada ao Claude pelo Agent SDK (#66). O Worker não chama o Claude: a única credencial é o
// token de setup do Claude Code (CLAUDE_CODE_OAUTH_TOKEN), que serve ao Claude Code e ao Agent SDK
// e não à Messages API crua. O SDK lê o token do ambiente; este módulo nunca o vê (#66).
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** #66 Modelo padrão das tarefas: rápido e barato, a regra determinística confirma depois. */
export const DEFAULT_MODEL = 'claude-haiku-5-5';

export type JsonSchema = Record<string, unknown>;

export type AskOptions = {
  readonly system: string;
  readonly prompt: string;
  readonly schema: JsonSchema;
  readonly model?: string;
};

/** #66 A pergunta ao Claude, injetável: as tarefas recebem um Ask e os testes passam um falso. */
export type Ask = <T>(options: AskOptions) => Promise<T>;

/** #66 O formato do query() do SDK que este módulo usa. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage | unknown>;

/** #66 Falha da chamada ao Claude. A mensagem diz o subtipo do resultado, nunca o texto do modelo. */
export class ClaudeError extends Error {
  constructor(detail: string) {
    super(`claude: ${detail}`);
    this.name = 'ClaudeError';
  }
}

type ResultLike = { type: 'result'; subtype: string; is_error?: boolean; structured_output?: unknown };

function isResult(message: unknown): message is ResultLike {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'result';
}

/**
 * #66 Monta o Ask sobre um query(). Saída estruturada pelo outputFormat do SDK
 * ({ type: 'json_schema', schema }), que devolve o objeto validado em result.structured_output.
 * Sem ferramenta nenhuma (tools: [] tira as embutidas, allowedTools: [] não libera nada), sem ler
 * settings nem CLAUDE.md do disco (settingSources: []) e sem gravar a sessão (persistSession: false).
 */
export function createAsk(query: QueryFn): Ask {
  return async <T>(options: AskOptions): Promise<T> => {
    const messages = query({
      prompt: options.prompt,
      options: {
        systemPrompt: options.system,
        model: options.model ?? DEFAULT_MODEL,
        tools: [],
        allowedTools: [],
        settingSources: [],
        persistSession: false,
        // #66 Um turno de pergunta; a saída estruturada fecha o turno pela ferramenta de fim de turno
        // do SDK, que pode pedir uma volta a mais quando o JSON vem fora do schema.
        maxTurns: 2,
        outputFormat: { type: 'json_schema', schema: options.schema },
      },
    });
    for await (const message of messages) {
      if (!isResult(message)) continue;
      if (message.subtype !== 'success') throw new ClaudeError(`resultado ${message.subtype}`);
      // #66 Falha de autenticação ou da API chega como success com is_error; o texto não é gravado.
      if (message.is_error) throw new ClaudeError('resultado com is_error');
      if (message.structured_output === undefined) throw new ClaudeError('resultado sem saída estruturada');
      return message.structured_output as T;
    }
    throw new ClaudeError('a sessão terminou sem resultado');
  };
}

/** #66 O Ask de produção, sobre o query() do Agent SDK, carregado só quando é usado. */
export const askClaude: Ask = async <T>(options: AskOptions): Promise<T> => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return createAsk(query as QueryFn)<T>(options);
};
