/**
 * Executor do Claude (#66): roda no GitHub Actions, de 5 em 5 minutos, porque o Worker não tem
 * como chamar o Claude (só há o token de setup do Claude Code). Para cada tarefa registrada, lê o
 * que está pendente, pergunta ao Claude e grava a sugestão em claude_suggestions. O Worker só lê (#66).
 */
import { pathToFileURL } from 'node:url';
import { askClaude, ClaudeError, DEFAULT_MODEL, type Ask } from './claude.ts';
import { isInteger, isString, isTimestamp, partitionRows, shaped, type Shape } from './guards.ts';
import { SupabaseClient, SupabaseError, type Db, type Row } from './supabase.ts';
import type { ClaudeTask, PendingRequest } from './task.ts';
import { TASKS } from './tasks/index.ts';

const TABLE = 'claude_suggestions';
/** #66 Teto de pedidos por tarefa a cada rodada; o resto fica para a próxima. */
export const MAX_PER_RUN = 50;
/** #66 Depois de 3 tentativas com erro, a chave não é mais tentada pelo laço. */
export const MAX_ATTEMPTS = 3;
/** #66 Espera entre tentativas com erro: 5 min * 2^tentativas desde updated_at. */
const BACKOFF_BASE_MS = 5 * 60_000;
const MAX_ERROR = 200;

export type RunOptions = {
  readonly db: Db;
  readonly ask: Ask;
  readonly tasks: readonly ClaudeTask<unknown, unknown>[];
  readonly log: (line: string) => void;
  readonly limit?: number;
  /** #66 Valores que nunca podem aparecer na mensagem de erro gravada. */
  readonly secrets?: readonly string[];
  /** #66 Relógio injetável, para a espera entre tentativas ser testável. */
  readonly now?: () => Date;
};

export type RunResult = { readonly failedTasks: string[] };

/** #66 O que o laço lê de cada linha de claude_suggestions. */
type StoredSuggestion = {
  readonly input_key: string;
  readonly status: string;
  readonly attempts: number;
  readonly updated_at: string;
};

const isStoredSuggestion = shaped<StoredSuggestion>({
  input_key: isString,
  status: isString,
  attempts: isInteger,
  updated_at: isTimestamp,
} satisfies Shape<StoredSuggestion>);

/**
 * #66 O que vai para a coluna error e para o log. Só os erros que o executor mesmo escreve
 * (ClaudeError e SupabaseError) levam a mensagem, truncada e sem segredo; qualquer outro, como os
 * do SDK e do processo do Claude Code, leva só o nome da classe, porque o texto deles não é nosso.
 */
export function storedError(error: unknown, secrets: readonly string[] = []): string {
  const name = error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : 'Error';
  if (!(error instanceof ClaudeError || error instanceof SupabaseError)) return `${name}: erro inesperado`;
  let message = error.message;
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redigido]');
  return `${name}: ${message.slice(0, MAX_ERROR)}`;
}

type Existing = { readonly byKey: Map<string, StoredSuggestion>; readonly dropped: number };

async function existingSuggestions(db: Db, task: string): Promise<Existing> {
  const rows = await db.select(TABLE, {
    select: 'input_key,status,attempts,updated_at',
    filters: { task: `eq.${task}` },
    order: 'input_key.asc',
  });
  const { valid, dropped } = partitionRows(rows, isStoredSuggestion);
  return { byKey: new Map(valid.map((row) => [row.input_key, row])), dropped };
}

function inBackoff(row: StoredSuggestion, now: Date): boolean {
  return now.getTime() < Date.parse(row.updated_at) + BACKOFF_BASE_MS * 2 ** row.attempts;
}

type Plan = { readonly queue: PendingRequest<unknown>[]; readonly waiting: number };

/**
 * #66 A fila da rodada: as chaves nunca tentadas primeiro, depois as que erraram. A chave em erro
 * com MAX_ATTEMPTS tentativas, ou ainda na espera, fica de fora. O teto vem depois dessa ordem.
 */
function planQueue(pending: readonly PendingRequest<unknown>[], existing: Existing, now: Date, limit: number): Plan {
  const fresh: PendingRequest<unknown>[] = [];
  const retries: PendingRequest<unknown>[] = [];
  let waiting = 0;
  for (const request of pending) {
    const row = existing.byKey.get(request.key);
    if (row === undefined) fresh.push(request);
    else if (row.status === 'ok') continue;
    else if (row.attempts >= MAX_ATTEMPTS || inBackoff(row, now)) waiting += 1;
    else retries.push(request);
  }
  return { queue: [...fresh, ...retries].slice(0, limit), waiting };
}

type Counts = { ok: number; failed: number; firstError: string | undefined };

async function runOne(
  task: ClaudeTask<unknown, unknown>,
  request: PendingRequest<unknown>,
  options: RunOptions,
  previous: StoredSuggestion | undefined,
  counts: Counts,
): Promise<void> {
  const attempts = previous?.attempts ?? 0;
  let row: Row;
  try {
    const output = await task.run(request.input, options.ask);
    row = { output, status: 'ok', error: null, attempts };
    counts.ok += 1;
  } catch (error) {
    const message = storedError(error, options.secrets);
    row = { output: null, status: 'error', error: message, attempts: attempts + 1 };
    counts.failed += 1;
    counts.firstError ??= message;
  }
  const updatedAt = (options.now ?? (() => new Date()))().toISOString();
  // #66 A linha nova entra com ignore-duplicates; a que estava em erro é refeita com merge-duplicates.
  await options.db.upsert(
    TABLE,
    [{ task: task.name, input_key: request.key, input: request.input, model: DEFAULT_MODEL, updated_at: updatedAt, ...row }],
    { onConflict: 'task,input_key', resolution: previous === undefined ? 'ignore' : 'merge' },
  );
}

function summaryLine(name: string, pending: number, counts: Counts, extra: { waiting: number; dropped: number }): string {
  const parts = [`tarefa ${name}: ${pending} pendentes, ok ${counts.ok}, erro ${counts.failed}`];
  if (counts.firstError !== undefined) parts.push(`primeiro erro: ${counts.firstError}`);
  if (extra.waiting > 0) parts.push(`em espera ${extra.waiting}`);
  if (extra.dropped > 0) parts.push(`linhas descartadas ${extra.dropped}`);
  return parts.join(', ');
}

type TaskOutcome = { readonly line: string; readonly failed: boolean };

async function runTask(task: ClaudeTask<unknown, unknown>, options: RunOptions): Promise<TaskOutcome> {
  const existing = await existingSuggestions(options.db, task.name);
  const { requests, dropped } = await task.pending(options.db);
  const pending = requests.filter((request) => existing.byKey.get(request.key)?.status !== 'ok');
  const now = (options.now ?? (() => new Date()))();
  const plan = planQueue(pending, existing, now, options.limit ?? MAX_PER_RUN);
  const counts: Counts = { ok: 0, failed: 0, firstError: undefined };
  for (const request of plan.queue) await runOne(task, request, options, existing.byKey.get(request.key), counts);
  const line = summaryLine(task.name, pending.length, counts, { waiting: plan.waiting, dropped: dropped + existing.dropped });
  // #66 Todas as chamadas falharem é a tarefa falhar: o workflow não pode ficar verde com o token vencido.
  return { line, failed: counts.ok === 0 && counts.failed > 0 };
}

/** #66 Roda as tarefas em sequência. A falha de uma tarefa inteira é registrada e não para as outras. */
export async function runTasks(options: RunOptions): Promise<RunResult> {
  const failedTasks: string[] = [];
  for (const task of options.tasks) {
    try {
      const outcome = await runTask(task, options);
      options.log(outcome.line);
      if (outcome.failed) failedTasks.push(task.name);
    } catch (error) {
      failedTasks.push(task.name);
      options.log(`tarefa ${task.name}: falhou (${storedError(error, options.secrets)})`);
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
