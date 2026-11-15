// Registro das tarefas do executor do Claude (#66): uma linha por tarefa.
import type { ClaudeTask } from '../task.ts';
import { descriptionMatch } from './description-match.ts';

export const TASKS: readonly ClaudeTask<unknown, unknown>[] = [
  descriptionMatch, // #66 casamento de descrição do item sem cadastro
];
