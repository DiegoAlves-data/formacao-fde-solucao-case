// #35 (plano #66, AC-5): o Cron manda ao Cadastro o item sem cadastro das propostas já aprovadas por uma pessoa.
import type { ApprovalStore } from '../approval/store.js';
import type { RegistryCorrectionOutbox } from '../connectors/ports.js';
import { publishUnregisteredItems } from '../registry/publish-unregistered-items.js';

export type PublishApprovedDeps = {
  readonly store: Pick<ApprovalStore, 'listDecidedOn'>;
  readonly outbox: RegistryCorrectionOutbox;
  /** #66 Os dias (AAAA-MM-DD) cujas decisões entram na rodada. */
  readonly days: readonly string[];
};

/**
 * #66 Os últimos `count` dias em UTC (AAAA-MM-DD), de hoje para trás. O Cron usa 7: uma falha de até uma
 * semana, ou uma decisão tomada antes de um deploy, ainda chega ao Cadastro na rodada seguinte. Passar
 * disso perde a mensagem, e a caixa de saída idempotente (#59) é o que deixa a janela larga sem duplicar.
 */
export function lastDaysUtc(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) => new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
}

/**
 * #35, AC-5: para cada processo decidido nos dias dados, com proposta aprovada ou alterada e um E8 na nota,
 * publica na caixa de saída do Cadastro. A caixa é idempotente (#59): repetir o dia não cria mensagem nova.
 */
export async function publishApprovedUnregistered(deps: PublishApprovedDeps): Promise<{ published: number }> {
  const files = (await Promise.all(deps.days.map((day) => deps.store.listDecidedOn(day)))).flat();
  const withE8 = files.filter(
    (f) =>
      (f.proposal.state === 'aprovada' || f.proposal.state === 'alterada') &&
      f.invoice.divergences.some((d) => d.classification === 'E8'),
  );
  if (withE8.length === 0) return { published: 0 };

  let published = 0;
  for (const file of withE8) {
    published += await publishUnregisteredItems(file.invoice, file.proposal, deps.outbox);
  }
  return { published };
}
