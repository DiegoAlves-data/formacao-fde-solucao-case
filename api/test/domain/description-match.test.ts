import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDescriptionMatches,
  confirmsDescriptionMatch,
  matchByDescription,
  primeDescriptionMatches,
  withDescriptionMatches,
  type DescriptionSuggester,
} from '../../src/domain/description-match.js';

/** Sugestor falso: devolve a sugestão fixa e conta as chamadas, sem rede. */
function fakeSuggester(answer: (description: string, candidates: readonly string[]) => number | null) {
  const calls: { description: string; candidates: readonly string[] }[] = [];
  const suggester: DescriptionSuggester = {
    async suggest(description, candidates) {
      calls.push({ description, candidates });
      return answer(description, candidates);
    },
  };
  return { suggester, calls };
}

const failingSuggester: DescriptionSuggester = {
  async suggest() {
    throw new Error('Claude fora do ar');
  },
};

beforeEach(() => {
  clearDescriptionMatches();
});

describe('regra sozinha (sem sugestão do Claude)', () => {
  it('AC-2: casa "Arroz 5kg" com "Arroz 5 kg" e não com o feijão', () => {
    expect(matchByDescription('Arroz 5kg', ['Feijão 1 kg', 'Arroz 5 kg'])).toBe(1);
  });

  it('AC-2: ignora acento, caixa e o texto entre parênteses, e converte litro para mililitro', () => {
    expect(matchByDescription('Leite integral 1 L (lançamento)', ['leite integral 1000 ml'])).toBe(0);
  });

  it('AC-2: entende vírgula decimal e unidade colada ao número', () => {
    expect(matchByDescription('Refrigerante cola 1,5l', ['Refrigerante Cola 1500 ml'])).toBe(0);
  });

  it('AC-3: tamanho diferente não casa', () => {
    expect(matchByDescription('Isotônico limão 500 ml', ['Isotônico limão 1 L'])).toBeNull();
  });

  it('AC-3: sabor diferente não casa', () => {
    expect(matchByDescription('Isotônico limão 500 ml', ['Isotônico laranja 500 ml'])).toBeNull();
  });

  it('AC-3: "sem açúcar" contra "com açúcar" não é casamento forte', () => {
    expect(matchByDescription('Suco uva sem açúcar 1 L', ['Suco uva com açúcar 1 L'])).toBeNull();
  });

  it('AC-3: empate no topo é ambíguo e não casa', () => {
    expect(matchByDescription('Arroz 5kg', ['Arroz 5 kg', 'arroz 5000 g'])).toBeNull();
  });

  it('AC-3: sem candidatos ou com descrição em branco, não casa', () => {
    expect(matchByDescription('Arroz 5kg', [])).toBeNull();
    expect(matchByDescription('   ', ['Arroz 5 kg'])).toBeNull();
  });
});

describe('confirmsDescriptionMatch', () => {
  it('AC-2: confirma descrições parecidas com a mesma medida', () => {
    expect(confirmsDescriptionMatch('Refrigerante cola 2L garrafa', 'Refrigerante cola 2 L')).toBe(true);
  });

  it('AC-3: não confirma medida diferente nem sabor diferente', () => {
    expect(confirmsDescriptionMatch('Isotônico limão 500 ml', 'Isotônico limão 1 L')).toBe(false);
    expect(confirmsDescriptionMatch('Isotônico limão 500 ml', 'Isotônico laranja 500 ml')).toBe(false);
  });

  it('AC-2: quando um dos lados não tem medida, a medida não bloqueia', () => {
    expect(confirmsDescriptionMatch('Detergente neutro', 'Detergente neutro 500 ml')).toBe(true);
  });
});

describe('sugestão do Claude confirmada pela regra', () => {
  const description = 'Refrigerante cola 2L garrafa';
  const candidates = ['Refrigerante cola 2 L', 'Refrigerante guaraná 2 L'];

  it('AC-2: sem sugestão, a regra sozinha não é forte o bastante', () => {
    expect(matchByDescription(description, candidates)).toBeNull();
  });

  it('AC-2: a sugestão do Claude confirmada pela regra devolve o índice sugerido', async () => {
    const { suggester } = fakeSuggester(() => 0);
    await primeDescriptionMatches(suggester, [{ description, candidates }]);
    expect(matchByDescription(description, candidates)).toBe(0);
  });

  it('AC-3: sugestão que a regra não confirma (tamanho diferente) cai na regra sozinha e não casa', async () => {
    const desc = 'Isotônico limão 500 ml';
    const cands = ['Isotônico limão 1 L'];
    const { suggester } = fakeSuggester(() => 0);
    await primeDescriptionMatches(suggester, [{ description: desc, candidates: cands }]);
    expect(matchByDescription(desc, cands)).toBeNull();
  });

  it('AC-2: sugestão não confirmada ainda deixa a regra sozinha decidir', async () => {
    const cands = ['Feijão 1 kg', 'Arroz 5 kg'];
    const { suggester } = fakeSuggester(() => 0);
    await primeDescriptionMatches(suggester, [{ description: 'Arroz 5kg', candidates: cands }]);
    expect(matchByDescription('Arroz 5kg', cands)).toBe(1);
  });

  it('AC-3: Claude falhando, a regra sozinha decide e nada fica guardado', async () => {
    await primeDescriptionMatches(failingSuggester, [
      { description, candidates },
      { description: 'Arroz 5kg', candidates: ['Feijão 1 kg', 'Arroz 5 kg'] },
    ]);
    expect(matchByDescription(description, candidates)).toBeNull();
    expect(matchByDescription('Arroz 5kg', ['Feijão 1 kg', 'Arroz 5 kg'])).toBe(1);

    const { suggester, calls } = fakeSuggester(() => 0);
    await primeDescriptionMatches(suggester, [{ description, candidates }]);
    expect(calls).toHaveLength(1);
    expect(matchByDescription(description, candidates)).toBe(0);
  });

  it('AC-3: índice fora do intervalo ou não inteiro é guardado como null', async () => {
    const { suggester, calls } = fakeSuggester(() => 7);
    await primeDescriptionMatches(suggester, [{ description, candidates }]);
    expect(matchByDescription(description, candidates)).toBeNull();

    const { suggester: decimal } = fakeSuggester(() => 0.5);
    await primeDescriptionMatches(decimal, [{ description: 'Refrigerante cola 2 L lata', candidates }]);
    expect(matchByDescription('Refrigerante cola 2 L lata', candidates)).toBeNull();

    // O null ficou guardado: pedir de novo não chama o Claude outra vez.
    await primeDescriptionMatches(suggester, [{ description, candidates }]);
    expect(calls).toHaveLength(1);
  });

  it('AC-2: pedidos repetidos são deduplicados e o cache não chama o Claude de novo', async () => {
    const { suggester, calls } = fakeSuggester(() => 0);
    await primeDescriptionMatches(suggester, [
      { description, candidates },
      { description, candidates: [...candidates] },
    ]);
    await primeDescriptionMatches(suggester, [{ description, candidates }]);
    expect(calls).toHaveLength(1);
  });

  it('AC-2: o cache é chaveado por descrição e candidatos juntos', async () => {
    const { suggester } = fakeSuggester(() => 0);
    await primeDescriptionMatches(suggester, [{ description, candidates }]);
    const reordered = ['Refrigerante guaraná 2 L', 'Refrigerante cola 2 L'];
    expect(matchByDescription(description, reordered)).toBeNull();
    expect(matchByDescription('Refrigerante cola 2L pet', candidates)).toBeNull();
  });

  it('AC-2: clearDescriptionMatches esquece as sugestões', async () => {
    const { suggester } = fakeSuggester(() => 0);
    await primeDescriptionMatches(suggester, [{ description, candidates }]);
    clearDescriptionMatches();
    expect(matchByDescription(description, candidates)).toBeNull();
  });
});

describe('withDescriptionMatches: o cache vale só para uma rodada', () => {
  const description = 'Refrigerante cola 2L garrafa';
  const candidates = ['Refrigerante cola 2 L', 'Refrigerante guaraná 2 L'];

  it('AC-2: dentro de run, a sugestão confirmada vale', async () => {
    const { suggester } = fakeSuggester(() => 0);
    const inside = await withDescriptionMatches(suggester, [{ description, candidates }], () =>
      matchByDescription(description, candidates),
    );
    expect(inside).toBe(0);
  });

  it('AC-2: depois da rodada, a sugestão não vale mais e volta a regra sozinha', async () => {
    const { suggester } = fakeSuggester(() => 0);
    await withDescriptionMatches(suggester, [{ description, candidates }], async () => undefined);
    expect(matchByDescription(description, candidates)).toBeNull();
  });

  it('AC-2: o cache é limpo também quando run lança', async () => {
    const { suggester } = fakeSuggester(() => 0);
    await expect(
      withDescriptionMatches(suggester, [{ description, candidates }], () => {
        throw new Error('falhou a rodada');
      }),
    ).rejects.toThrow('falhou a rodada');
    expect(matchByDescription(description, candidates)).toBeNull();
  });
});

describe('"sem X" muda o produto', () => {
  it('AC-2: o Claude sugere "com açúcar" para "sem açúcar" e a regra não confirma', async () => {
    const description = 'Suco uva sem açúcar 1 L';
    const candidates = ['Suco uva com açúcar 1 L'];
    expect(confirmsDescriptionMatch(description, candidates[0]!)).toBe(false);
    const { suggester } = fakeSuggester(() => 0);
    await primeDescriptionMatches(suggester, [{ description, candidates }]);
    expect(matchByDescription(description, candidates)).toBeNull();
  });

  it('AC-3: só um dos lados com "sem X" não confirma nem casa pela regra sozinha', () => {
    expect(confirmsDescriptionMatch('Iogurte natural sem lactose 170 g', 'Iogurte natural 170 g')).toBe(false);
    expect(confirmsDescriptionMatch('Iogurte natural 170 g', 'Iogurte natural sem lactose 170 g')).toBe(false);
    expect(matchByDescription('Leite integral zero lactose sem lactose 1 L', ['Leite integral zero lactose 1 L'])).toBeNull();
  });

  it('AC-2: os dois lados com o mesmo "sem X" continuam casando', () => {
    expect(matchByDescription('Iogurte natural sem lactose 170g', ['Iogurte natural sem lactose 170 g'])).toBe(0);
  });
});
