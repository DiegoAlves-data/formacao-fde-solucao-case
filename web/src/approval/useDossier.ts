// #130 O dossiê da gaveta: pedir ao Claude e ler a proposta de novo enquanto ele escreve.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { approvalApi } from "../api/approval";
import type { DossierGeneratingDto, ProposalDossierDto } from "../api/contract";
import { texts } from "../texts";

/** #130 De quanto em quanto tempo a gaveta lê a proposta de novo enquanto o status é `generating`. */
export const DOSSIER_POLL_MS = 3_000;
/** #130 Teto da espera: a geração sob demanda tem prazo de 20 s no Worker; passado isto, a gaveta para de ler. */
export const DOSSIER_POLL_LIMIT_MS = 90_000;

export interface DossierState {
  /** #130 O que a gaveta mostra: em geração, o estado Gerando no lugar do anterior (AC-4). */
  dossier: ProposalDossierDto | null | undefined;
  /** #130 O aviso do 409, do 429 ou de outra recusa do pedido. */
  message: string | null;
  busy: boolean;
  request: () => Promise<void>;
}

/** #130 O texto da recusa do pedido, em português para quem decide. */
export function requestError(reason: unknown): string {
  if (reason instanceof ApiError && reason.status === 409) return texts.dossier.request.inFlight;
  if (reason instanceof ApiError && reason.status === 429) return texts.dossier.request.limit;
  return texts.dossier.request.other;
}

export function useDossier(accessKey: string, initial: ProposalDossierDto | null | undefined): DossierState {
  const [dossier, setDossier] = useState(initial);
  const [generating, setGenerating] = useState<DossierGeneratingDto | null>(initial?.status === "generating" ? initial : null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // #130 AC-4: num "Gerar de novo", o dossiê pronto anterior só sai quando chega um mais novo que o pedido.
  const since = useRef<string | null>(null);

  // #130 A gaveta trocou de proposta (ou a proposta foi relida): começa do que veio.
  useEffect(() => {
    setDossier(initial);
    setGenerating(initial?.status === "generating" ? initial : null);
    setMessage(null);
    since.current = null;
  }, [accessKey, initial]);

  const polling = generating !== null;
  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    const deadline = Date.now() + DOSSIER_POLL_LIMIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = (await approvalApi.proposal(accessKey, controller.signal)).dossier;
        if (controller.signal.aborted) return;
        const stale = next?.status === "ready" && since.current !== null && next.generatedAt < since.current;
        if (next?.status === "generating" || (stale && Date.now() < deadline)) {
          if (next?.status === "generating") setGenerating(next);
          timer = setTimeout(tick, DOSSIER_POLL_MS);
          return;
        }
        setDossier(next);
        setGenerating(null);
        setMessage(null);
        since.current = null;
      } catch {
        // #130 Uma leitura que falhou não encerra a espera; o teto é que encerra.
        if (controller.signal.aborted) return;
        if (Date.now() < deadline) timer = setTimeout(tick, DOSSIER_POLL_MS);
        else setGenerating(null);
      }
    };
    timer = setTimeout(tick, DOSSIER_POLL_MS);
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [polling, accessKey]);

  const request = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const started = await approvalApi.requestDossier(accessKey);
      since.current = started.requestedAt;
      setGenerating(started);
    } catch (reason) {
      setMessage(requestError(reason));
      // #130 409: o Claude já está escrevendo; a gaveta fica em Gerando e espera a resposta.
      if (reason instanceof ApiError && reason.status === 409) {
        setGenerating({ status: "generating", trigger: "on_demand", requestedBy: "", requestedAt: "" });
      }
    } finally {
      setBusy(false);
    }
  }, [accessKey]);

  return { dossier: generating ?? dossier, message, busy, request };
}
