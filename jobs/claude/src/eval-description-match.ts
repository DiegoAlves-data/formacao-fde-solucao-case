// Eval do casamento de descrição (#66, AC-6). Monta o conjunto só a partir do kit (data/kit/notas.json
// e data/kit/produtos.json), nunca de data/kit/excecoes.json nem de outro gabarito, e pergunta ao
// Claude pelo mesmo run da tarefa description-match, sem gravar nada no banco. Precisa só do
// CLAUDE_CODE_OAUTH_TOKEN. Roda pelo workflow claude-enrich com eval = true.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { askClaude, type Ask } from './claude.ts';
import {
  descriptionMatch,
  sortCandidates,
  type DescriptionMatchInput,
  type KitProduto,
} from './tasks/description-match.ts';

export type KitNotaComItens = {
  readonly chave: string;
  readonly fornecedor_id: string;
  readonly itens: readonly { codigo_fornecedor: string; sku: string | null; descricao: string }[];
};

export type EvalCase = { readonly variant: string; readonly input: DescriptionMatchInput; readonly expected: string | null };
export type EvalResult = { readonly variant: string; readonly expected: string | null; readonly answer: string | null; readonly failed: boolean };

const MEASURE = /^(.*\S)\s+(\d+(?:,\d+)?)\s+(L|ml|kg|g|un)$/;
const NOISE_SUFFIX = ' cx c/12';
const CONCURRENCY = 4;

function parseNumber(text: string): number {
  return Number(text.replace(',', '.'));
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(6))).replace('.', ',');
}

/** #66 Separa a medida do fim da descrição ("Refrigerante cola 2 L" → palavras + "2" "L"). */
function splitMeasure(description: string): { words: string[]; amount?: string; unit?: string } {
  const m = MEASURE.exec(description);
  if (!m) return { words: description.split(/\s+/) };
  return { words: m[1]!.split(/\s+/), amount: m[2]!, unit: m[3]! };
}

const CONVERSION: Record<string, { unit: string; factor: number }> = {
  L: { unit: 'ml', factor: 1000 },
  ml: { unit: 'L', factor: 1 / 1000 },
  kg: { unit: 'g', factor: 1000 },
  g: { unit: 'kg', factor: 1 / 1000 },
};

/** #66 As variantes determinísticas de uma descrição do kit; a que não se aplica fica de fora. */
export function variants(description: string): { variant: string; description: string }[] {
  const { words, amount, unit } = splitMeasure(description);
  const measure = amount && unit ? `${amount} ${unit}` : undefined;
  const join = (ws: string[]) => [...ws, ...(measure ? [measure] : [])].join(' ');
  const out: { variant: string; description: string }[] = [];

  const longIndex = words.findIndex((w) => /^\p{L}{6,}$/u.test(w));
  if (longIndex >= 0) {
    const cut = words[longIndex]!.slice(0, 5);
    out.push({ variant: 'abreviacao-com-ponto', description: join(words.map((w, i) => (i === longIndex ? `${cut}.` : w))) });
    out.push({ variant: 'abreviacao-sem-ponto', description: join(words.map((w, i) => (i === longIndex ? cut : w))) });
  }
  if (measure) {
    out.push({ variant: 'palavras-reordenadas', description: `${measure} ${words.join(' ')}` });
  } else if (words.length >= 2) {
    out.push({ variant: 'palavras-reordenadas', description: [words[1]!, words[0]!, ...words.slice(2)].join(' ') });
  }
  const conversion = unit ? CONVERSION[unit] : undefined;
  if (amount && conversion) {
    const rewritten = `${formatNumber(parseNumber(amount) * conversion.factor)} ${conversion.unit}`;
    out.push({ variant: 'medida-reescrita', description: `${words.join(' ')} ${rewritten}` });
  }
  out.push({ variant: 'sufixo-ruido', description: `${description}${NOISE_SUFFIX}` });
  if (words.length >= 2) out.push({ variant: 'ultima-palavra-removida', description: join(words.slice(0, -1)) });
  return out;
}

/** #66 A mesma descrição com o número do tamanho dobrado; sem número, não há variante. */
function doubledSize(description: string): string | undefined {
  const { words, amount, unit } = splitMeasure(description);
  if (amount && unit) return `${words.join(' ')} ${formatNumber(parseNumber(amount) * 2)} ${unit}`;
  const m = /^(.*\D)?(\d+(?:,\d+)?)(\D*)$/.exec(description);
  if (!m) return undefined;
  return `${m[1] ?? ''}${formatNumber(parseNumber(m[2]!) * 2)}${m[3] ?? ''}`;
}

/**
 * #66 Positivos: as variantes de cada item de nota cujo sku existe no cadastro, esperando a descrição
 * do produto entre os candidatos do fornecedor. Negativos: os itens sem sku e cada produto com o
 * tamanho dobrado, esperando null.
 */
export function buildEvalDataset(notas: readonly KitNotaComItens[], produtos: readonly KitProduto[]): EvalCase[] {
  const porSku = new Map(produtos.map((p) => [p.sku, p]));
  const candidatosDo = new Map<string, string[]>();
  for (const p of produtos) candidatosDo.set(p.fornecedor_id, [...(candidatosDo.get(p.fornecedor_id) ?? []), p.descricao]);
  const candidates = (fornecedor: string) => sortCandidates(candidatosDo.get(fornecedor) ?? []);

  const positivos: EvalCase[] = [];
  const vistos = new Set<string>();
  const negativos: EvalCase[] = [];
  for (const nota of notas) {
    const lista = candidates(nota.fornecedor_id);
    if (lista.length === 0) continue;
    for (const item of nota.itens) {
      if (item.sku === null) {
        negativos.push({ variant: 'sem-cadastro', input: { description: item.descricao, candidates: lista }, expected: null });
        continue;
      }
      const produto = porSku.get(item.sku);
      if (!produto || vistos.has(`${item.sku}\u0000${item.descricao}`)) continue;
      vistos.add(`${item.sku}\u0000${item.descricao}`);
      for (const v of variants(item.descricao)) {
        positivos.push({ variant: v.variant, input: { description: v.description, candidates: lista }, expected: produto.descricao });
      }
    }
  }
  for (const p of produtos) {
    const dobrada = doubledSize(p.descricao);
    if (dobrada) negativos.push({ variant: 'medida-dobrada', input: { description: dobrada, candidates: candidates(p.fornecedor_id) }, expected: null });
  }
  return [...positivos, ...negativos];
}

export type EvalSummary = {
  readonly total: number;
  readonly positives: number;
  readonly negatives: number;
  readonly accuracy: number;
  readonly precision: number;
  readonly recall: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falsePositivesOnNegatives: number;
  readonly claudeFailures: number;
  readonly byVariant: Record<string, { total: number; correct: number; accuracy: number }>;
};

const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);

/** #66 A falha do Claude conta como resposta null: é o que o Worker faria sem sugestão (fail-closed). */
export function summarize(results: readonly EvalResult[]): EvalSummary {
  const positives = results.filter((r) => r.expected !== null);
  const truePositives = positives.filter((r) => r.answer === r.expected).length;
  const falsePositives = results.filter((r) => r.answer !== null && r.answer !== r.expected).length;
  const byVariant: EvalSummary['byVariant'] = {};
  for (const r of results) {
    const v = (byVariant[r.variant] ??= { total: 0, correct: 0, accuracy: 0 });
    v.total += 1;
    if (r.answer === r.expected) v.correct += 1;
    v.accuracy = ratio(v.correct, v.total);
  }
  return {
    total: results.length,
    positives: positives.length,
    negatives: results.length - positives.length,
    accuracy: ratio(results.filter((r) => r.answer === r.expected).length, results.length),
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, positives.length),
    truePositives,
    falsePositives,
    falsePositivesOnNegatives: results.filter((r) => r.expected === null && r.answer !== null).length,
    claudeFailures: results.filter((r) => r.failed).length,
    byVariant,
  };
}

/** #66 Pergunta caso a caso pelo run da tarefa, com poucas chamadas em paralelo. */
export async function runEval(cases: readonly EvalCase[], ask: Ask, concurrency = CONCURRENCY): Promise<EvalResult[]> {
  const results: EvalResult[] = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < cases.length; i = next++) {
      const c = cases[i]!;
      try {
        const { match } = await descriptionMatch.run(c.input, ask);
        results[i] = { variant: c.variant, expected: c.expected, answer: match, failed: false };
      } catch {
        results[i] = { variant: c.variant, expected: c.expected, answer: null, failed: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function readKit<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`../../../data/kit/${name}`, import.meta.url), 'utf8')) as T;
}

async function main(): Promise<void> {
  const notas = await readKit<KitNotaComItens[]>('notas.json');
  const produtos = await readKit<KitProduto[]>('produtos.json');
  const cases = buildEvalDataset(notas, produtos);
  const results = await runEval(cases, askClaude);
  const s = summarize(results);
  console.log('Eval do casamento de descrição (#66, AC-6)');
  console.log(`casos: ${s.total} (positivos ${s.positives}, negativos ${s.negatives})`);
  console.log(`acurácia ${pct(s.accuracy)}, precisão ${pct(s.precision)}, revocação ${pct(s.recall)}`);
  console.log(`falsos positivos nos negativos: ${s.falsePositivesOnNegatives}; falhas do Claude: ${s.claudeFailures}`);
  for (const [variant, v] of Object.entries(s.byVariant)) console.log(`  ${variant}: ${v.correct}/${v.total} (${pct(v.accuracy)})`);
  const erros = results
    .map((r, i) => ({ ...r, description: cases[i]!.input.description }))
    .filter((r) => r.answer !== r.expected);
  console.log(JSON.stringify({ summary: s, errors: erros }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`eval: ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'falha'}`);
    process.exitCode = 1;
  });
}
