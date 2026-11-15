// Executor do Claude (#66): roda no GitHub Actions, de 5 em 5 minutos, porque o Worker não tem
// como chamar o Claude (só há o token de setup do Claude Code). Para cada tarefa registrada, lê o
// que está pendente, pergunta ao Claude e grava a sugestão em claude_suggestions. O Worker só lê.
import { pathToFileURL } from 'node:url';
import { askClaude, DEFAULT_MODEL, type Ask } from './claude.ts';
import { SupabaseClient, type Db, type Row } from './supabase.ts';
import type { ClaudeTask } from './task.ts';
import { TASKS } from './tasks/index.ts';

const TABLE = 'claude_suggestions';
/** #66 Teto de pedidos por tarefa a cada rodada; o resto fica para a próxima. */
export const MAX_PER_RUN = 50;
const MAX_ERROR = 200;

export type RunOptions = {
  readonly db: Db;
  readonly ask: Ask;
  readonly tasks: readonly ClaudeTask<unknown, unknown>[];
  readonly log: (line: string) => void;
  readonly limit?: number;
  /** #66 Valores que nunca podem aparecer na mensagem de erro gravada. */
  readonly secrets?: readonly string[];
};

export type RunResult = { readonly failedTasks: string[] };

/** #66 Erro curto para a coluna error: classe e os primeiros 200 caracteres, sem segredo. */
export function shortError(error: unknown, secrets: readonly string[] = []): string {
  const name = error instanceof Error ? error.name : 'Erro';
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redigido]');
  return `${name}: ${message.slice(0, MAX_ERROR)}`;
}

async function existingKeys(db: Db, task: string): Promise<{ ok: Set<string>; erro: Set<string> }> {
  const rows = await db.select(TABLE, { select: 'input_key,status', filters: { task: `eq.${task}` } });
  const ok = new Set<string>();
  const erro = new Set<string>();
  for (const row of rows) (row.status === 'ok' ? ok : erro).add(String(row.input_key));
  return { ok, erro };
}

async function runTask(task: ClaudeTask<unknown, unknown>, options: RunOptions): Promise<string> {
  const { db, ask } = options;
  const { ok, erro } = await existingKeys(db, task.name);
  const pending = (await task.pending(db)).filter((request) => !ok.has(request.key));
  let okCount = 0;
  let erroCount = 0;
  for (const request of pending.slice(0, options.limit ?? MAX_PER_RUN)) {
    let row: Row;
    try {
      const output = await task.run(request.input, ask);
      row = { output, status: 'ok', error: null };
      okCount += 1;
    } catch (error) {
      row = { output: null, status: 'erro', error: shortError(error, options.secrets) };
      erroCount += 1;
    }
    // #66 A linha nova entra com ignore-duplicates; a que estava em erro é refeita com merge-duplicates.
    await db.upsert(
      TABLE,
      [{ task: task.name, input_key: request.key, input: request.input, model: DEFAULT_MODEL, ...row }],
      { onConflict: 'task,input_key', resolution: erro.has(request.key) ? 'merge' : 'ignore' },
    );
  }
  return `tarefa ${task.name}: ${pending.length} pendentes, ok ${okCount}, erro ${erroCount}`;
}

/** #66 Roda as tarefas em sequência. A falha de uma tarefa inteira é registrada e não para as outras. */
export async function runTasks(options: RunOptions): Promise<RunResult> {
  const failedTasks: string[] = [];
  for (const task of options.tasks) {
    try {
      options.log(await runTask(task, options));
    } catch (error) {
      failedTasks.push(task.name);
      options.log(`tarefa ${task.name}: falhou (${shortError(error, options.secrets)})`);
    }
  }
  return { failedTasks };
}

export type Config = {
  readonly supabaseUrl: string;
  readonly supabaseSecretKey: string;
  readonly tasks: string[];
};

/** #66 Lê o ambiente. A falta de variável nomeia a variável, nunca mostra um valor. */
export function readConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`variável de ambiente ausente: ${name}`);
    return value;
  };
  return {
    supabaseUrl: required('BARTE_ACADEMY_SUPABASE_URL'),
    supabaseSecretKey: required('BARTE_ACADEMY_SUPABASE_SECRET_KEY'),
    tasks: (env.CLAUDE_TASKS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  };
}

/** #66 Sem nomes, todas as tarefas; nome desconhecido é erro para não rodar nada pela metade. */
export function selectTasks(names: readonly string[]): ClaudeTask<unknown, unknown>[] {
  if (names.length === 0) return [...TASKS];
  return names.map((name) => {
    const task = TASKS.find((t) => t.name === name);
    if (!task) throw new Error(`tarefa desconhecida: ${name} (conhecidas: ${TASKS.map((t) => t.name).join(', ')})`);
    return task;
  });
}

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const tasks = selectTasks(config.tasks);
  const db = new SupabaseClient({ url: config.supabaseUrl, secretKey: config.supabaseSecretKey });
  const secrets = [config.supabaseSecretKey, process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ''];
  const result = await runTasks({ db, ask: askClaude, tasks, log: (line) => console.log(line), secrets });
  if (result.failedTasks.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`executor do Claude: ${error instanceof Error ? error.message : 'falha'}`);
    process.exitCode = 1;
  });
}
