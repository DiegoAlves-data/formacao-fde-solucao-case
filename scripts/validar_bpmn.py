"""Confere que cada arquivo BPMN é XML válido e que todo fluxo liga elementos que existem."""

import sys
import xml.etree.ElementTree as ET

BPMN = "{http://www.omg.org/spec/BPMN/20100524/MODEL}"
DI = "{http://www.omg.org/spec/BPMN/20100524/DI}"


def validar(caminho: str) -> list[str]:
    erros = []
    raiz = ET.parse(caminho).getroot()
    ids = {el.get("id") for el in raiz.iter() if el.get("id")}
    for fluxo in raiz.iter(f"{BPMN}sequenceFlow"):
        for ponta in ("sourceRef", "targetRef"):
            if fluxo.get(ponta) not in ids:
                erros.append(f"{fluxo.get('id')}: {ponta} {fluxo.get(ponta)} não existe")
    desenhados = {el.get("bpmnElement") for el in raiz.iter() if el.get("bpmnElement")}
    for el in raiz.iter():
        tag = el.tag.replace(BPMN, "")
        if el.tag.startswith(BPMN) and el.get("id") and tag not in {
            "definitions", "process", "laneSet", "collaboration", "conditionExpression"
        } and not el.tag.startswith(DI):
            if el.get("id") not in desenhados:
                erros.append(f"{el.get('id')} ({tag}) não tem forma no diagrama")
    return erros


if __name__ == "__main__":
    arquivos = sys.argv[1:]
    if not arquivos or arquivos == ["docs/processo/*.bpmn"]:
        print("nenhum arquivo .bpmn encontrado")
        sys.exit(0)
    falhou = False
    for arquivo in arquivos:
        erros = validar(arquivo)
        for erro in erros:
            print(f"{arquivo}: {erro}")
        falhou = falhou or bool(erros)
        if not erros:
            print(f"{arquivo}: ok")
    sys.exit(1 if falhou else 0)
