/**
 * Casamento por descrição (plano #66, E8; usado também pelo #65).
 *
 * O Claude sugere, a regra confirma: a sugestão do Claude só vale quando a regra determinística
 * a confirma. Sem sugestão (ou com uma que a regra rejeita), decide a regra sozinha, com um
 * limiar mais alto. Como a verificação é síncrona, o Claude é consultado antes, numa rodada
 * (`withDescriptionMatches`), e as sugestões ficam num cache que a verificação só lê.
 */

/** Porta para quem sugere o casamento (o Claude, em produção). Devolve o índice do candidato ou null. */
export interface DescriptionSuggester {
  suggest(description: string, candidates: readonly string[]): Promise<number | null>;
}

/** Um pedido de casamento: a descrição da nota e as descrições do cadastro do fornecedor. */
export interface DescriptionMatchRequest {
  description: string;
  candidates: readonly string[];
}

const MAX_CACHED = 2000;
const CONFIRM_THRESHOLD = 0.5;
const STRONG_THRESHOLD = 0.8;

const suggestions = new Map<string, number | null>();

function cacheKey(description: string, candidates: readonly string[]): string {
  return JSON.stringify([description, candidates]);
}

function remember(key: string, index: number | null): void {
  suggestions.delete(key);
  suggestions.set(key, index);
  while (suggestions.size > MAX_CACHED) {
    const oldest = suggestions.keys().next();
    if (oldest.done) break;
    suggestions.delete(oldest.value);
  }
}

function validIndex(index: unknown, length: number): number | null {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < length ? index : null;
}

/**
 * Pede ao sugestor o casamento de cada pedido ainda fora do cache e guarda a resposta (inclusive null).
 * Se o sugestor falha num pedido, nada é guardado para ele e a regra sozinha decide (falha fechada).
 * Devolve quantos pedidos falharam, para quem chama deixar rastro.
 */
export async function primeDescriptionMatches(
  suggester: DescriptionSuggester,
  requests: readonly DescriptionMatchRequest[],
): Promise<number> {
  let failures = 0;
  const seen = new Set<string>();
  for (const { description, candidates } of requests) {
    const key = cacheKey(description, candidates);
    if (seen.has(key) || suggestions.has(key)) continue;
    seen.add(key);
    try {
      const index = await suggester.suggest(description, candidates);
      remember(key, validIndex(index, candidates.length));
    } catch {
      failures++; // #66: falha fechada, sem sugestão a regra decide sozinha.
    }
  }
  return failures;
}

/** Esquece todas as sugestões guardadas. */
export function clearDescriptionMatches(): void {
  suggestions.clear();
}

/**
 * É este o jeito de usar o Claude numa rodada de conferência: pede as sugestões, roda `run`
 * (que chama as verificações, e por elas `matchByDescription`) e limpa o cache no fim, mesmo
 * quando `run` lança. Um isolate do Worker sobrevive entre invocações, e uma sugestão velha
 * não pode decidir a nota seguinte. Se algum pedido ao Claude falha, `onSuggestionFailures`
 * recebe o total antes de `run`.
 */
export async function withDescriptionMatches<T>(
  suggester: DescriptionSuggester,
  requests: readonly DescriptionMatchRequest[],
  run: () => T | Promise<T>,
  onSuggestionFailures?: (failures: number) => void,
): Promise<T> {
  try {
    const failures = await primeDescriptionMatches(suggester, requests);
    if (failures > 0) onSuggestionFailures?.(failures);
    return await run();
  } finally {
    clearDescriptionMatches();
  }
}

// ---------------------------------------------------------------------------------------------
// #66: a regra determinística.

const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'para']);

/**
 * #66: palavras de variante. Mudam o produto (cola zero não é cola), então precisam aparecer dos
 * dois lados ou de nenhum, como o "sem X". Lista fixa, já sem acento.
 */
const VARIANT_WORDS = new Set([
  'zero',
  'diet',
  'light',
  'integral',
  'desnatado',
  'semidesnatado',
  'organico',
  'tradicional',
  'original',
]);

/** #66: abreviação mínima que conta como a mesma palavra (refri ~ refrigerante). */
const MIN_PREFIX = 4;
const MEASURE = /(\d+(?:\.\d+)?)\s*(kg|mg|ml|g|l|un|cx)(?![a-z0-9])/g;
const TO_BASE: Record<string, { factor: number; unit: string }> = {
  kg: { factor: 1000, unit: 'g' },
  g: { factor: 1, unit: 'g' },
  mg: { factor: 1, unit: 'mg' },
  l: { factor: 1000, unit: 'ml' },
  ml: { factor: 1, unit: 'ml' },
  un: { factor: 1, unit: 'un' },
  cx: { factor: 1, unit: 'cx' },
};

interface Normalized {
  words: Set<string>;
  measures: Set<string>;
  /** #66: as palavras que vêm depois de "sem" ("sem açúcar" guarda "acucar"); mudam o produto. */
  without: Set<string>;
}

function normalize(text: string): Normalized {
  let s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/(\d),(\d)/g, '$1.$2');

  const measures = new Set<string>();
  s = s.replace(MEASURE, (_match, amount: string, unit: string) => {
    const base = TO_BASE[unit];
    if (base) {
      const value = Number((Number(amount) * base.factor).toFixed(6));
      measures.add(`${value}${base.unit}`);
    }
    return ' ';
  });

  const tokens = s.split(/[^a-z0-9]+/).filter((t) => t !== '' && !STOPWORDS.has(t));
  const without = new Set<string>();
  tokens.forEach((token, i) => {
    const next = tokens[i + 1];
    if (token === 'sem' && next !== undefined) without.add(next);
  });
  return { words: new Set(tokens), measures, without };
}

function sameMeasures(a: Normalized, b: Normalized): boolean {
  if (a.measures.size === 0 || b.measures.size === 0) return true;
  if (a.measures.size !== b.measures.size) return false;
  for (const m of a.measures) if (!b.measures.has(m)) return false;
  return true;
}

/**
 * #66: "sem X" precisa estar dos dois lados ou de nenhum. Isso recusa "sem açúcar" × "com açúcar"
 * e também "sem lactose" contra um candidato que não diz "sem lactose".
 */
function sameWithout(a: Normalized, b: Normalized): boolean {
  if (a.without.size !== b.without.size) return false;
  for (const w of a.without) if (!b.without.has(w)) return false;
  return true;
}

/** #66: a mesma palavra, ou uma abreviação de 4 letras ou mais que é prefixo da outra. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_PREFIX && long.startsWith(short);
}

interface WordComparison {
  common: number;
  onlyA: number;
  onlyB: number;
}

/** #66: pareia as palavras um a um, a igual primeiro e depois a abreviada. */
function compareWords(a: Set<string>, b: Set<string>): WordComparison {
  const free = new Set(b);
  const unmatched: string[] = [];
  let common = 0;
  for (const w of a) {
    if (free.delete(w)) common++;
    else unmatched.push(w);
  }
  for (const w of unmatched) {
    const partner = [...free].find((other) => sameWord(w, other));
    if (partner === undefined) continue;
    free.delete(partner);
    common++;
  }
  return { common, onlyA: a.size - common, onlyB: b.size - common };
}

function sameVariants(a: Normalized, b: Normalized): boolean {
  for (const w of VARIANT_WORDS) if (a.words.has(w) !== b.words.has(w)) return false;
  return true;
}

/**
 * #66: a pontuação da regra (Jaccard com abreviações) ou null quando a regra recusa o par: medida
 * diferente, "sem X" ou variante de um lado só, ou cada lado com uma palavra que o outro não tem
 * (chocolate × morango). Palavra a mais de um lado só não recusa: o Jaccard decide.
 */
function ruleScore(description: Normalized, candidate: Normalized): number | null {
  if (!sameMeasures(description, candidate) || !sameWithout(description, candidate)) return null;
  if (!sameVariants(description, candidate)) return null;
  const { common, onlyA, onlyB } = compareWords(description.words, candidate.words);
  if (onlyA > 0 && onlyB > 0) return null;
  const union = common + onlyA + onlyB;
  return union === 0 ? 0 : common / union;
}

function score(description: Normalized, candidate: Normalized, threshold: number): number | null {
  const s = ruleScore(description, candidate);
  return s !== null && s >= threshold ? s : null;
}

/** A regra confirma que a descrição e o candidato são o mesmo produto (mesma medida, palavras parecidas). */
export function confirmsDescriptionMatch(description: string, candidate: string): boolean {
  return score(normalize(description), normalize(candidate), CONFIRM_THRESHOLD) !== null;
}

/**
 * Casa a descrição de um item com uma lista de candidatos e devolve o índice do que casa, ou null.
 * Usado quando o código do fornecedor não basta (E2, E8 e a conciliação da contagem).
 * Dona: plano #66 (E8), usado também pelo #65 (ordem provável).
 *
 * Não mude o nome nem a assinatura.
 */
export function matchByDescription(description: string, candidates: readonly string[]): number | null {
  if (candidates.length === 0 || description.trim() === '') return null;

  const target = normalize(description);
  const normalized = candidates.map(normalize);

  const suggested = suggestions.get(cacheKey(description, candidates));
  if (suggested !== undefined && suggested !== null) {
    const candidate = normalized[suggested];
    const suggestedScore = candidate === undefined ? null : score(target, candidate, CONFIRM_THRESHOLD);
    const beaten =
      suggestedScore !== null &&
      normalized.some((other, i) => i !== suggested && (ruleScore(target, other) ?? -1) > suggestedScore);
    if (suggestedScore !== null && !beaten) return suggested;
  }

  let best: number | null = null;
  let bestScore = -1;
  let tied = false;
  normalized.forEach((candidate, index) => {
    const s = score(target, candidate, STRONG_THRESHOLD);
    if (s === null) return;
    if (s > bestScore) {
      best = index;
      bestScore = s;
      tied = false;
    } else if (s === bestScore) {
      tied = true;
    }
  });
  return tied ? null : best;
}
