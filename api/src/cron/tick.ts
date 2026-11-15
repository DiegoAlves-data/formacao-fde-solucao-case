import { listDescriptionSuggestions, storedDescriptionSuggester } from "../connectors/claude-suggestions";
import { supabaseConnectors } from "../connectors/supabase-connectors";
import { SupabaseRest, SupabaseRestError } from "../connectors/supabase-rest";
import type { DescriptionSuggester } from "../domain/description-match";
import type { Env } from "../env";
import { captureInvoices } from "./capture";
import { findUnreconciledReceipts } from "./unreconciled-receipts";
import { proposeChecked } from "../approval/propose-checked";

/** Execução agendada: captura e confere as notas (#59). Registra uma linha, sem dado sensível. */
export async function tick(controller: Pick<ScheduledController, "cron">, env: Env): Promise<void> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.log(`cron: execução agendada (${controller.cron}); sem credenciais do Supabase, captura pulada`);
    return;
  }
  const rest = new SupabaseRest({ url, secretKey });
  const { captureDeps } = supabaseConnectors(rest);
  const descriptions = await storedSuggestions(rest);
  const result = await captureInvoices(descriptions ? { ...captureDeps, descriptions } : captureDeps);
  const unreconciled = await findUnreconciledReceipts(captureDeps);
  // #63 Depois de conferir, propõe e encaminha pela régua; o match vai sozinho para a lista do dia.
  const proposals = await proposeChecked({
    rest,
    purchasing: captureDeps.purchasing,
    registry: captureDeps.registry,
  });
  console.log(
    `cron: execução agendada (${controller.cron}); notas vistas ${result.seen}, novas ${result.inserted}, conferidas ${result.checked}, com erro ${result.failed}, propostas ${proposals.proposed}, aprovadas pela regra ${proposals.approvedByRule}; recebimentos sem nota [${unreconciled.noKey.join(", ")}], com chave sem nota [${unreconciled.keyWithoutInvoice.join(", ")}]`,
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
