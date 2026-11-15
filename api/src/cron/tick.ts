import { listDescriptionSuggestions, storedDescriptionSuggester } from "../connectors/claude-suggestions";
import { supabaseConnectors } from "../connectors/supabase-connectors";
import { SupabaseRest, SupabaseRestError } from "../connectors/supabase-rest";
import type { RegistryCorrectionOutbox, RegistryPort } from "../connectors/ports";
import type { DescriptionSuggester } from "../domain/description-match";
import type { Env } from "../env";
import { captureInvoices } from "./capture";
import { findUnreconciledReceipts } from "./unreconciled-receipts";
import { proposeChecked } from "../approval/propose-checked";
import { SupabaseApprovalStore } from "../approval/supabase-store";
import { publishApprovedSemCadastro } from "./publish-approved-e8";

/** Execução agendada: captura e confere as notas (#59). Registra uma linha, sem dado sensível. */
export async function tick(controller: Pick<ScheduledController, "cron">, env: Env): Promise<void> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada (${controller.cron}); sem credenciais do Supabase, captura pulada`);
    return;
  }
  const rest = new SupabaseRest({ url, secretKey });
  const { captureDeps, registryCorrections } = supabaseConnectors(rest);
  const descriptions = await storedSuggestions(rest);
  const result = await captureInvoices(descriptions ? { ...captureDeps, descriptions } : captureDeps);
  const unreconciled = await findUnreconciledReceipts(captureDeps);
  // #63 Depois de conferir, propõe e encaminha pela régua; o match vai sozinho para a lista do dia.
  const proposals = await proposeChecked({
    rest,
    purchasing: captureDeps.purchasing,
    registry: captureDeps.registry,
  });
  const cadastroE8 = await publishApproved(rest, captureDeps.registry, registryCorrections);
  console.log(
    `cron: execução agendada (${controller.cron}); notas vistas ${result.seen}, novas ${result.inserted}, conferidas ${result.checked}, com erro ${result.failed}, propostas ${proposals.proposed}, aprovadas pela regra ${proposals.approvedByRule}, cadastro E8 ${cadastroE8}; recebimentos sem nota [${unreconciled.noKey.join(", ")}], com chave sem nota [${unreconciled.keyWithoutInvoice.join(", ")}]`,
  );
}

/**
 * #66 As sugestões de casamento por descrição que o job claude-enrich gravou. Se a leitura falha,
 * registra uma linha (só o status, sem dado sensível) e a regra decide sozinha.
 */
async function storedSuggestions(rest: SupabaseRest): Promise<DescriptionSuggester | undefined> {
  try {
    return storedDescriptionSuggester(await listDescriptionSuggestions(rest));
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na leitura";
    console.log(`cron: sugestões do Claude indisponíveis (${status}); a regra decide sozinha`);
    return undefined;
  }
}

/**
 * #35 (plano #66, AC-5) Manda ao Cadastro o E8 das propostas decididas hoje e ontem (UTC). Se falha, registra
 * uma linha sem dado sensível e a rodada segue: a caixa de saída é idempotente e a próxima rodada repete.
 */
async function publishApproved(
  rest: SupabaseRest,
  registry: RegistryPort,
  outbox: RegistryCorrectionOutbox,
): Promise<number> {
  try {
    const now = Date.now();
    const days = [new Date(now), new Date(now - 24 * 60 * 60 * 1000)].map((d) => d.toISOString().slice(0, 10));
    const { published } = await publishApprovedSemCadastro({ store: new SupabaseApprovalStore(rest), registry, outbox, days });
    return published;
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : "falha na publicação";
    console.log(`cron: cadastro E8 indisponível (${status}); a próxima rodada repete`);
    return 0;
  }
}
