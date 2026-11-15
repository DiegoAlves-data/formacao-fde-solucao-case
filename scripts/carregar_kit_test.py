"""Testes offline da transformação JSON -> linhas da carga da base do kit."""
import json
import os
import unittest
from decimal import Decimal

import carregar_kit as ck

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DADOS = os.path.join(RAIZ, "data", "kit")
ESPERADO = {
    "kit_fornecedores": 12, "kit_produtos": 37, "kit_ordens": 102, "kit_ordem_itens": 288,
    "kit_notas": 80, "kit_nota_itens": 218, "kit_notas_lancadas": 34, "kit_nota_lancada_itens": 98,
    "kit_pagamentos": 9, "kit_recebimentos": 71, "kit_recebimento_itens": 183,
    "kit_regua": 1, "kit_excecoes": 8,
}


def arquivo(nome):
    with open(os.path.join(DADOS, nome), encoding="utf-8") as f:
        return json.load(f, parse_float=Decimal)


class TransformacaoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contrato = ck.carregar_contrato(DADOS)
        cls.linhas = ck.montar_linhas(DADOS)

    def test_contagem_por_tabela_bate_com_a_regra_do_contrato(self):
        self.assertEqual(ESPERADO, {t: len(r) for t, r in self.linhas.items()})
        for t in self.contrato["tabelas"]:
            with self.subTest(tabela=t["nome"]):
                self.assertEqual(ck.contagem_esperada(t, DADOS), len(self.linhas[t["nome"]]))

    def test_tabelas_vem_com_os_pais_antes_dos_filhos(self):
        ordem = list(self.linhas)
        for t in self.contrato["tabelas"]:
            for fk in t["chaves_estrangeiras"]:
                self.assertLess(ordem.index(fk["ref_tabela"]), ordem.index(t["nome"]))

    def test_linhas_tem_exatamente_as_colunas_do_contrato(self):
        for t in self.contrato["tabelas"]:
            colunas = [c["nome"] for c in t["colunas"]]
            for linha in self.linhas[t["nome"]]:
                self.assertEqual(colunas, list(linha))

    def test_chave_primaria_unica_em_cada_tabela(self):
        for t in self.contrato["tabelas"]:
            chaves = [tuple(l[c] for c in t["chave_primaria"]) for l in self.linhas[t["nome"]]]
            self.assertEqual(len(chaves), len(set(chaves)), t["nome"])

    def test_mesma_entrada_gera_as_mesmas_linhas(self):
        self.assertEqual(self.linhas, ck.montar_linhas(DADOS))

    def test_nulos_da_fonte_ficam_nulos(self):
        notas = {l["chave"]: l for l in self.linhas["kit_notas"]}
        self.assertEqual(19, sum(l["pedido_referenciado"] is None for l in notas.values()))
        self.assertEqual(9, sum(l["sku"] is None for l in self.linhas["kit_nota_itens"]))
        self.assertEqual(9, sum(l["sku"] is None for l in self.linhas["kit_ordem_itens"]))
        self.assertEqual(34, sum(l["nota_id"] is None for l in self.linhas["kit_notas_lancadas"]))
        self.assertEqual(9, sum(l["nota_chave"] is None for l in self.linhas["kit_pagamentos"]))
        self.assertEqual(9, sum(l["ordem_id"] is None for l in self.linhas["kit_recebimentos"]))

    def test_regua_vira_uma_linha_com_id_1(self):
        (linha,) = self.linhas["kit_regua"]
        fonte = arquivo("regua.json")
        self.assertEqual(1, linha["id"])
        self.assertEqual(fonte["niveis"], linha["niveis"])
        self.assertEqual(fonte["texto"], linha["texto"])
        self.assertEqual(Decimal("0.005"), linha["tolerancia_percentual"])

    def test_excecoes_viram_uma_linha_por_chave(self):
        fonte = arquivo("excecoes.json")
        self.assertEqual([(k, v) for k, v in fonte.items()],
                         [(l["codigo"], l["descricao"]) for l in self.linhas["kit_excecoes"]])

    def test_item_leva_a_chave_do_pai_e_os_campos_do_item(self):
        fonte = arquivo("notas.json")[0]
        itens = [l for l in self.linhas["kit_nota_itens"] if l["chave"] == fonte["chave"]]
        self.assertEqual(len(fonte["itens"]), len(itens))
        self.assertEqual(fonte["itens"][0]["valor"], itens[0]["valor"])

    def test_nada_do_gabarito_no_repositorio(self):
        self.assertFalse(os.path.exists(os.path.join(DADOS, "gabarito")))

    def test_soma_do_json_e_exata_em_decimal(self):
        soma = ck.somar(self.linhas["kit_ordens"], "valor_total")
        self.assertIsInstance(soma, Decimal)
        self.assertEqual(sum((Decimal(str(o["valor_total"])) for o in arquivo("ordens.json")), Decimal(0)), soma)


if __name__ == "__main__":
    unittest.main()
