// #35, AC-6: eval da acurácia do casamento por descrição na base do kit, com o Claude e só com a regra.
// #35 Pula sem BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN ou BARTE_ACADEMY_ANTHROPIC_API_KEY. Nenhum valor de
// credencial é impresso. Com EVAL_WRITE=1, grava o resumo em description-match.eval.result.json.
// #35 O conjunto sai só das notas e do cadastro do kit, nunca de data/kit/excecoes.json (o gabarito).
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeDescriptionSuggester } from '../../src/connectors/claude-description-suggester.js';
import { matchByDescription, withDescriptionMatches, type DescriptionSuggester } from '../../src/domain/index.js';
import { kitDomain } from '../support/kit-domain.js';

function env(name: string): string | undefined {
  const value: unknown = Reflect.get(process.env, name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const API_KEY = env('BARTE_ACADEMY_ANTHROPIC_API_KEY');
const OAUTH_TOKEN = env('BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN');
const ONLINE = Boolean(API_KEY || OAUTH_TOKEN);

type EvalCase = {
  readonly description: string;
  readonly candidates: readonly string[];
  /** #35 O índice do produto certo entre os candidatos; null quando o item não tem cadastro. */
  readonly expected: number | null;
};

type Metrics = { readonly accuracy: number; readonly precision: number; readonly recall: number };

/** #35 Positivos: cada (fornecedor, descrição) distinto com SKU no cadastro. Negativos: cada item sem SKU. */
async function dataset(): Promise<EvalCase[]> {
  const { invoices, ctx } = await kitDomain();
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const invoice of invoices) {
    const products = ctx.products.filter((p) => p.supplierId === invoice.supplierId);
    const candidates = products.map((p) => p.description);
    for (const item of invoice.items) {
      if (item.sku === null) {
        cases.push({ description: item.description, candidates, expected: null });
        continue;
      }
      const expected = products.findIndex((p) => p.sku === item.sku);
      const key = JSON.stringify([invoice.supplierId, item.description]);
      if (expected < 0 || seen.has(key)) continue;
      seen.add(key);
      cases.push({ description: item.description, candidates, expected });
    }
  }
  return cases;
}

/** #35 Positivo é casar. Acerto é casar o índice certo, ou não casar o item sem cadastro. */
function metrics(cases: readonly EvalCase[], predicted: readonly (number | null)[]): Metrics & { falsePositivesOnNegatives: number } {
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
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
    precision: predictedPositives === 0 ? 1 : truePositives / predictedPositives,
    recall: positives === 0 ? 1 : truePositives / positives,
    falsePositivesOnNegatives,
  };
}

async function predict(cases: readonly EvalCase[], suggester: DescriptionSuggester | null): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (const c of cases) {
    const run = () => matchByDescription(c.description, c.candidates);
    out.push(suggester ? await withDescriptionMatches(suggester, [c], run) : run());
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

describe.skipIf(!ONLINE)('#35 eval do casamento por descrição (online, com o Claude)', () => {
  it('AC-6: mede acurácia, precisão e revocação na base do kit, com o Claude e só com a regra', async () => {
    const cases = await dataset();
    const suggester = API_KEY ? claudeDescriptionSuggester({ apiKey: API_KEY }) : claudeDescriptionSuggester({ oauthToken: OAUTH_TOKEN });

    const rule = metrics(cases, await predict(cases, null));
    const claude = metrics(cases, await predict(cases, suggester));

    const positives = cases.filter((c) => c.expected !== null).length;
    const summary =
      `AC-6 casamento por descrição: ${cases.length} casos (${positives} positivos, ${cases.length - positives} negativos); ` +
      `com o Claude acurácia ${pct(claude.accuracy)}, precisão ${pct(claude.precision)}, revocação ${pct(claude.recall)}; ` +
      `só a regra acurácia ${pct(rule.accuracy)}, precisão ${pct(rule.precision)}, revocação ${pct(rule.recall)}.`;
    console.log(`  ${summary}`);
    if (env('EVAL_WRITE') === '1') {
      writeFileSync(
        new URL('./description-match.eval.result.json', import.meta.url),
        `${JSON.stringify({ cases: cases.length, positives, claude, rule, summary }, null, 2)}\n`,
      );
    }

    expect(claude.falsePositivesOnNegatives).toBe(0);
    expect(claude.accuracy).toBeGreaterThanOrEqual(rule.accuracy - 0.05);
  }, 180_000);
});
