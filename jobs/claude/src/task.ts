// O contrato de uma tarefa do executor do Claude (#66). Cada tarefa vive num arquivo de
// src/tasks/ e entra no registro de src/tasks/index.ts com uma linha. Outros planos (#65, #68)
// acrescentam as suas sem mexer no laço.
import type { Ask } from './claude.ts';
import type { Db } from './supabase.ts';

/** #66 Um pedido pendente: a chave estável da entrada e a entrada em si. */
export type PendingRequest<I> = { readonly key: string; readonly input: I };

export type ClaudeTask<I, O> = {
  /** #66 Nome gravado em claude_suggestions.task; o Worker lê por ele. */
  readonly name: string;
  /** #66 O que falta sugerir, lido do banco. O laço tira o que já está ok. */
  pending(db: Db): Promise<PendingRequest<I>[]>;
  /** #66 Pergunta ao Claude e devolve a saída já validada, pronta para gravar. */
  run(input: I, ask: Ask): Promise<O>;
};
