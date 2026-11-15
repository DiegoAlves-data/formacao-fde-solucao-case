// #35, AC-6: eval do casamento por descrição na base do kit, só com a regra. Roda sempre, dentro do
// make check, sem credencial. #66 A medida com o Claude sai do vitest e vai para o job do GitHub
// Actions que grava as sugestões. Com EVAL_WRITE=1, grava o resumo em description-match.eval.result.json.
// #66 As descrições das notas do kit são iguais às do cadastro, então o eval mede variações
// determinísticas delas (abreviação, ordem, unidade, ruído, parcial) e negativos difíceis
// (outra medida, outro produto), além dos itens sem SKU. Nada sai de data/kit/excecoes.json.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchByDescription, type Product } from '../../src/domain/index.js';
import { kitDomain } from '../support/kit-domain.js';

function env(name: string): string | undefined {
  const value: unknown = Reflect.get(process.env, name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * #66 Revocação mínima total da regra sozinha: a medida no kit, arredondada para baixo à casa de 5
 * pontos percentuais. Se a regra mudar e a revocação subir, suba este piso junto.
 */
const MIN_RULE_RECALL = 0.5; // #66 medida: 60,7% em 298 casos, com a abreviação só com ponto

const POSITIVE_KINDS = ['exata', 'abrev', 'abrev_sem_ponto', 'ordem', 'unidade', 'ruido', 'parcial'] as const;
const NEGATIVE_KINDS = ['outra_medida', 'outro_produto', 'sem_sku'] as const;
type Kind = (typeof POSITIVE_KINDS)[number] | (typeof NEGATIVE_KINDS)[number];

type EvalCase = {
  readonly kind: Kind;
  readonly description: string;
  readonly candidates: readonly string[];
  /** #35 O índice do produto certo entre os candidatos; null quando nenhum é o mesmo produto. */
  readonly expected: number | null;
};

// ---------------------------------------------------------------------------------------------
// #66 As variações, determinísticas, a partir da própria descrição.

const MEASURE = /(\d+(?:,\d+)?)\s*(kg|g|ml|l|un)(?![\p{L}\d])/iu;

type Parsed = { readonly words: readonly string[]; readonly amount: number; readonly unit: string; readonly spaced: boolean } | null;

/** #66 Separa a medida ("1,5 L") das palavras; null quando a descrição não tem número com unidade. */
function parse(description: string): { words: string[]; measure: Parsed } {
  const m = MEASURE.exec(description);
  const rest = m ? description.replace(m[0], ' ') : description;
  const words = rest.split(/\s+/).filter((w) => w !== '');
  if (!m || m[1] === undefined || m[2] === undefined) return { words, measure: null };
  return {
    words,
    measure: { words, amount: Number(m[1].replace(',', '.')), unit: m[2], spaced: /\s/.test(m[0]) },
  };
}

function num(x: number): string {
  return String(Number(x.toFixed(6))).replace('.', ',');
}

function measureText(amount: number, unit: string, spaced = true): string {
  return `${num(amount)}${spaced ? ' ' : ''}${unit}`;
}

function join(words: readonly string[], measure: Parsed): string {
  return measure ? `${words.join(' ')} ${measureText(measure.amount, measure.unit, measure.spaced)}` : words.join(' ');
}

/** #66 A mesma medida escrita de outro jeito: L↔ml, kg↔g; un muda só o espaço. */
function otherUnit(measure: NonNullable<Parsed>): string {
  const u = measure.unit.toLowerCase();
  if (u === 'l') return measureText(measure.amount * 1000, 'ml');
  if (u === 'ml') return measureText(measure.amount / 1000, 'L');
  if (u === 'kg') return measureText(measure.amount * 1000, 'g');
  if (u === 'g') return measureText(measure.amount / 1000, 'kg');
  return measureText(measure.amount, measure.unit, !measure.spaced);
}

const NOISE = [' cx c/12', ' - pct'];

function variants(description: string, index: number): { kind: Kind; description: string }[] {
  const { words, measure } = parse(description);
  const out: { kind: Kind; description: string }[] = [{ kind: 'exata', description }];

  const long = description.match(/\p{L}{6,}/u)?.[0];
  if (long) {
    // #66 A regra aceita a abreviação marcada com ponto; sem o ponto, mede quanto o Claude acrescenta.
    out.push({ kind: 'abrev', description: description.replace(long, `${long.slice(0, 5)}.`) });
    out.push({ kind: 'abrev_sem_ponto', description: description.replace(long, long.slice(0, 5)) });
  }

  const reversed = [...words].reverse();
  if (words.length >= 2 && reversed.join(' ') !== words.join(' ')) {
    out.push({ kind: 'ordem', description: join(reversed, measure) });
  }

  if (measure) out.push({ kind: 'unidade', description: `${words.join(' ')} ${otherUnit(measure)}` });

  out.push({ kind: 'ruido', description: `${description}${NOISE[index % NOISE.length] ?? ''}` });

  if (words.length - 1 >= 2) out.push({ kind: 'parcial', description: join(words.slice(0, -1), measure) });

  return out.filter((v) => v.kind === 'exata' || v.description !== description);
}

/** #66 A descrição do produto com o número da medida dobrado; null sem número com unidade. */
function doubled(description: string): string | null {
  const m = MEASURE.exec(description);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const spaced = /\s/.test(m[0]);
  return description.replace(m[0], measureText(Number(m[1].replace(',', '.')) * 2, m[2], spaced));
}

/** #35 e #66: o conjunto do eval, só a partir das notas e do cadastro do kit. */
async function dataset(): Promise<EvalCase[]> {
  const { invoices, ctx } = await kitDomain();
  const bySupplier = new Map<string, Product[]>();
  for (const p of ctx.products) bySupplier.set(p.supplierId, [...(bySupplier.get(p.supplierId) ?? []), p]);
  const descriptionsOf = (supplierId: string) => (bySupplier.get(supplierId) ?? []).map((p) => p.description);

  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  let positiveIndex = 0;
  for (const invoice of invoices) {
    const products = bySupplier.get(invoice.supplierId) ?? [];
    const candidates = descriptionsOf(invoice.supplierId);
    for (const item of invoice.items) {
      if (item.sku === null) {
        cases.push({ kind: 'sem_sku', description: item.description, candidates, expected: null });
        continue;
      }
      const expected = products.findIndex((p) => p.sku === item.sku);
      const key = JSON.stringify([invoice.supplierId, item.description]);
      if (expected < 0 || seen.has(key)) continue;
      seen.add(key);
      for (const v of variants(item.description, positiveIndex)) cases.push({ ...v, candidates, expected });
      positiveIndex++;
    }
  }

  for (const products of bySupplier.values()) {
    products.forEach((product, i) => {
      const other = doubled(product.description);
      if (other) cases.push({ kind: 'outra_medida', description: other, candidates: [product.description], expected: null });
      const next = products[(i + 1) % products.length];
      if (next && next !== product) {
        cases.push({ kind: 'outro_produto', description: product.description, candidates: [next.description], expected: null });
      }
    });
  }
  return cases;
}

// ---------------------------------------------------------------------------------------------
// #66 As métricas, por tipo de variação e no total.

type Metrics = {
  readonly cases: number;
  readonly accuracy: number;
  /** #66 Positivo é casar; acerto positivo é casar o índice certo. */
  readonly precision: number;
  readonly recall: number;
  /** #66 Casos negativos (nenhum candidato é o mesmo produto) em que houve casamento. */
  readonly falsePositivesOnNegatives: number;
};

function metrics(cases: readonly EvalCase[], predicted: readonly (number | null)[]): Metrics {
  let correct = 0;
  let truePositives = 0;
  let predictedPositives = 0;
  let falsePositivesOnNegatives = 0;
  cases.forEach((c, i) => {
    const p = predicted[i] ?? null;
    if (p === c.expected) correct++;
    if (p !== null) predictedPositives++;
    if (p !== null && p === c.expected) truePositives++;
    if (c.expected === null && p !== null) falsePositivesOnNegatives++;
  });
  const positives = cases.filter((c) => c.expected !== null).length;
  return {
    cases: cases.length,
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
    precision: predictedPositives === 0 ? 1 : truePositives / predictedPositives,
    recall: positives === 0 ? 1 : truePositives / positives,
    falsePositivesOnNegatives,
  };
}

function byKind(cases: readonly EvalCase[], predicted: readonly (number | null)[]): Record<string, Metrics> {
  const out: Record<string, Metrics> = { total: metrics(cases, predicted) };
  for (const kind of [...POSITIVE_KINDS, ...NEGATIVE_KINDS]) {
    const idx = cases.map((c, i) => (c.kind === kind ? i : -1)).filter((i) => i >= 0);
    out[kind] = metrics(idx.map((i) => cases[i] as EvalCase), idx.map((i) => predicted[i] ?? null));
  }
  return out;
}

function predict(cases: readonly EvalCase[]): (number | null)[] {
  return cases.map((c) => matchByDescription(c.description, c.candidates));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function line(name: string, m: Metrics): string {
  return `${name}: ${m.cases} casos, acurácia ${pct(m.accuracy)}, precisão ${pct(m.precision)}, revocação ${pct(m.recall)}, falsos positivos ${m.falsePositivesOnNegatives}`;
}

const ALL_KINDS = ['total', ...POSITIVE_KINDS, ...NEGATIVE_KINDS];

function write(result: unknown): void {
  if (env('EVAL_WRITE') !== '1') return;
  writeFileSync(new URL('./description-match.eval.result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
}

describe('#35 eval do casamento por descrição, só com a regra', () => {
  it('AC-6: a regra sozinha não casa nenhum negativo e mantém a revocação mínima', async () => {
    const cases = await dataset();
    const rule = byKind(cases, predict(cases));

    console.log(`  AC-6 casamento por descrição, só a regra: ${cases.length} casos.`);
    for (const kind of ALL_KINDS) {
      const r = rule[kind];
      if (r) console.log(`    ${line(kind, r)}`);
    }
    write({ cases: cases.length, rule });

    expect(rule.total?.falsePositivesOnNegatives, 'falsos positivos nos negativos, só a regra').toBe(0);
    expect(rule.total?.recall ?? 0, 'revocação total da regra abaixo do piso').toBeGreaterThanOrEqual(MIN_RULE_RECALL);
  });
});
