import { Panel, ReconciliationDiff, type ComparisonField } from "@barte-ai-services/barte-ui-kit";
import { Alert } from "barte-design-system";
import type { EvidenceDto } from "../api/contract";
import { GenericEvidence } from "./GenericEvidence";
import { divergenceLabel } from "./labels";
import { registerEvidence, type EvidenceProps } from "./registry";

/** #66: o que a frase da evidência do checkItemSemCadastro (#35) diz do item; o que não casa fica null. */
interface ItemSemCadastro {
  description: string | null;
  value: string | null;
  supplierCode: string | null;
}

const DESCRIPTION = /^O item "(.+)" \(código do fornecedor /;
const VALUE = /valor (R\$ [\d.]+,\d{2})\)/;

/** #66: o código do fornecedor é a parte da referência depois da barra (`<fornecedor>/<código>`). */
function supplierCodeOf(reference: unknown): string | null {
  if (typeof reference !== "string") return null;
  const code = reference.slice(reference.indexOf("/") + 1);
  return reference.includes("/") && code !== "" ? code : null;
}

function parseItem(evidence: EvidenceDto): ItemSemCadastro {
  const text = typeof evidence.description === "string" ? evidence.description : "";
  return {
    description: DESCRIPTION.exec(text)?.[1] ?? null,
    value: VALUE.exec(text)?.[1] ?? null,
    supplierCode: supplierCodeOf(evidence.reference),
  };
}

/** #66: os campos de um item. O que a evidência não traz mostra a frase dela, nada é inventado. */
function fieldsOf(evidence: EvidenceDto, skus: string[]): ComparisonField[] {
  const item = parseItem(evidence);
  const sentence = evidence.description ?? "";
  const sku = skus[0];
  const failed = (key: string, label: string): ComparisonField => ({
    key,
    label,
    a: null,
    b: "não encontrado",
    state: "missing",
  });
  return [
    {
      key: "item",
      label: "Item da nota",
      a: item.description ?? sentence,
      b: "fora do cadastro",
      state: "divergent",
    },
    { key: "codigo", label: "Código do fornecedor", a: item.supplierCode ?? "não informado", b: null, state: "missing" },
    { key: "sku", label: "SKU", a: sku ?? "SKU vazio", b: null, state: "missing" },
    failed("busca-sku", "Busca por SKU"),
    failed("busca-codigo", "Busca por código do fornecedor"),
    failed("busca-descricao", "Busca por descrição"),
    ...(item.value
      ? [{ key: "risco", label: "Valor em risco", a: null, b: item.value, state: "divergent" } as ComparisonField]
      : []),
  ];
}

/**
 * E8 · Item sem cadastro. #66 (história #35): o item da nota que o cadastro do fornecedor não tem, as
 * três buscas que falharam, o valor em risco, e para onde a aprovação manda (AC-4 e AC-5). Evidência
 * ausente cai no genérico; frase fora do formato do #35 mostra a frase no lugar do campo.
 */
function ItemSemCadastroEvidence({ divergence }: EvidenceProps) {
  const evidence = Array.isArray(divergence.evidence) ? divergence.evidence : [];
  const record = evidence.find((e) => e?.source === "erp_cadastro");
  if (!record) return <GenericEvidence divergence={divergence} />;
  const skus = Array.isArray(divergence.skus) ? divergence.skus : [];

  return (
    <Panel
      title={divergenceLabel("E8")}
      description={`Evidência: Cadastro do ERP ${record.reference ?? ""}`}
      size="sm"
      padding="md"
    >
      <ReconciliationDiff
        columns={["Nota fiscal", "Cadastro do ERP"]}
        fields={fieldsOf(record, skus)}
        showSummary
        variant="grid"
        ariaLabel="Item sem cadastro"
      />
      <Alert
        variant="info"
        title="Vai para a coordenação"
        description="Aprovar manda o item ao Cadastro, para ser cadastrado antes de a nota seguir."
      />
    </Panel>
  );
}

registerEvidence("E8", ItemSemCadastroEvidence);
