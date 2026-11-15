"""Teste do contrato de dados da base do kit (offline).

Lê data/kit/contrato.json e a migração supabase/migrations/*_base_do_kit.sql e confere que cada
tabela do contrato existe com exatamente as suas colunas, tipos, chave primária, chaves
estrangeiras, únicas e checks, com RLS ligado e nenhuma política.
"""
import glob
import json
import os
import re
import unittest

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTRATO = os.path.join(RAIZ, "data", "kit", "contrato.json")
MIGRACOES = os.path.join(RAIZ, "supabase", "migrations")


def norm(texto):
    return re.sub(r"\s+", " ", texto.strip().lower()).replace("( ", "(").replace(" )", ")")


def carregar_contrato():
    with open(CONTRATO, encoding="utf-8") as f:
        return json.load(f)


def carregar_sql():
    arquivos = sorted(glob.glob(os.path.join(MIGRACOES, "*_base_do_kit.sql")))
    if not arquivos:
        raise AssertionError("migração *_base_do_kit.sql ausente em supabase/migrations/")
    with open(arquivos[0], encoding="utf-8") as f:
        sql = f.read()
    return re.sub(r"--[^\n]*", "", sql)


def separar_por_virgula(corpo):
    """Divide o corpo de um create table nas vírgulas de nível zero."""
    partes, nivel, atual = [], 0, ""
    for ch in corpo:
        if ch == "(":
            nivel += 1
        elif ch == ")":
            nivel -= 1
        if ch == "," and nivel == 0:
            partes.append(atual)
            atual = ""
        else:
            atual += ch
    if atual.strip():
        partes.append(atual)
    return [norm(p) for p in partes if p.strip()]


def ler_tabelas(sql):
    tabelas = {}
    for m in re.finditer(r"create table public\.(\w+)\s*\((.*?)\n\);", sql, re.S | re.I):
        nome, corpo = m.group(1), m.group(2)
        t = {"colunas": {}, "pk": None, "fks": [], "unicas": [], "checks": []}
        for parte in separar_por_virgula(corpo):
            parte = re.sub(r"^constraint \w+ ", "", parte)
            if parte.startswith("primary key"):
                t["pk"] = [c.strip() for c in re.search(r"\((.*)\)", parte).group(1).split(",")]
            elif parte.startswith("foreign key"):
                g = re.match(r"foreign key \((.*?)\) references public\.(\w+) ?\((.*?)\)$", parte)
                t["fks"].append((tuple(x.strip() for x in g.group(1).split(",")), g.group(2),
                                 tuple(x.strip() for x in g.group(3).split(","))))
            elif parte.startswith("unique"):
                t["unicas"].append(tuple(x.strip() for x in re.search(r"\((.*)\)", parte).group(1).split(",")))
            elif parte.startswith("check"):
                t["checks"].append(norm(re.match(r"check \((.*)\)$", parte).group(1)))
            else:
                g = re.match(r"(\w+) (.+?)( not null)?$", parte)
                t["colunas"][g.group(1)] = (g.group(2).replace(" ", ""), g.group(3) is None)
        tabelas[nome] = t
    return tabelas


class ContratoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contrato = carregar_contrato()
        cls.erro = None
        try:
            cls.sql = carregar_sql()
            cls.tabelas = ler_tabelas(cls.sql)
        except AssertionError as e:
            cls.erro = str(e)

    def setUp(self):
        if self.erro:
            self.fail(self.erro)

    def test_contrato_declara_o_essencial(self):
        c = self.contrato
        for chave in ("fonte_fixada", "frescor", "mudanca_incompativel", "consumidor", "completude",
                      "reconciliacao", "tabelas"):
            self.assertIn(chave, c)
        self.assertTrue(all(t["nome"].startswith(c["prefixo_tabelas"]) for t in c["tabelas"]))

    def test_so_as_tabelas_do_contrato_existem(self):
        esperadas = {t["nome"] for t in self.contrato["tabelas"]}
        self.assertEqual(esperadas, set(self.tabelas))

    def test_cada_tabela_tem_as_colunas_do_contrato(self):
        for t in self.contrato["tabelas"]:
            with self.subTest(tabela=t["nome"]):
                esperadas = {c["nome"]: (c["tipo"].replace(" ", ""), c["nulo"]) for c in t["colunas"]}
                self.assertEqual(esperadas, self.tabelas[t["nome"]]["colunas"])
                self.assertEqual([c["nome"] for c in t["colunas"]], list(self.tabelas[t["nome"]]["colunas"]))

    def test_chaves_primarias(self):
        for t in self.contrato["tabelas"]:
            with self.subTest(tabela=t["nome"]):
                self.assertEqual(t["chave_primaria"], self.tabelas[t["nome"]]["pk"])

    def test_chaves_estrangeiras(self):
        for t in self.contrato["tabelas"]:
            with self.subTest(tabela=t["nome"]):
                esperadas = sorted((tuple(f["colunas"]), f["ref_tabela"], tuple(f["ref_colunas"]))
                                   for f in t["chaves_estrangeiras"])
                self.assertEqual(esperadas, sorted(self.tabelas[t["nome"]]["fks"]))

    def test_unicas_e_checks(self):
        for t in self.contrato["tabelas"]:
            with self.subTest(tabela=t["nome"]):
                self.assertEqual(sorted(tuple(u) for u in t["unicas"]), sorted(self.tabelas[t["nome"]]["unicas"]))
                self.assertEqual(sorted(norm(c) for c in t["checks"]), sorted(self.tabelas[t["nome"]]["checks"]))

    def test_rls_ligado_em_toda_tabela(self):
        for t in self.contrato["tabelas"]:
            with self.subTest(tabela=t["nome"]):
                padrao = rf"alter table public\.{t['nome']}\s+enable row level security\s*;"
                self.assertRegex(self.sql, re.compile(padrao, re.I))
        self.assertNotRegex(self.sql, re.compile(r"disable row level security", re.I))

    def test_nenhuma_politica(self):
        self.assertNotRegex(self.sql, re.compile(r"create\s+policy", re.I))


if __name__ == "__main__":
    unittest.main()
