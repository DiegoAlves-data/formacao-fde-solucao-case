"""Testes online da base do kit no Supabase (AC-1, AC-2, AC-3).

Pulam, sem falhar, quando BARTE_ACADEMY_SUPABASE_URL ou BARTE_ACADEMY_SUPABASE_SECRET_KEY não
estão no ambiente. A carga (scripts/carregar_kit.py) deve ter rodado antes, como no fluxo do
GitHub Actions. Para rodar local:

    set -a; . ./.dev.vars; set +a
    python3 scripts/carregar_kit.py
    python3 -m unittest discover -s scripts -p 'kit_online_test.py' -v

A chave pública vem de BARTE_ACADEMY_SUPABASE_PUBLISHABLE_KEY; se faltar, o teste a busca na API
de gestão com BARTE_ACADEMY_SUPABASE_ACCESS_TOKEN e BARTE_ACADEMY_SUPABASE_PROJECT_ID. Sem
nenhuma das duas, só o teste da chave pública pula. Nenhum valor de chave é impresso.
"""
import json
import os
import unittest
import urllib.error
import urllib.request

import carregar_kit as ck

URL = os.environ.get(ck.VAR_URL)
CHAVE = os.environ.get(ck.VAR_CHAVE)
TEM_CREDENCIAL = bool(URL and CHAVE)


def chave_publica():
    direta = os.environ.get("BARTE_ACADEMY_SUPABASE_PUBLISHABLE_KEY")
    if direta:
        return direta
    token = os.environ.get("BARTE_ACADEMY_SUPABASE_ACCESS_TOKEN")
    projeto = os.environ.get("BARTE_ACADEMY_SUPABASE_PROJECT_ID")
    if not (token and projeto):
        return None
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{projeto}/api-keys",
                                 headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=30) as r:
        chaves = json.load(r)
    for tipo in ("publishable", "legacy"):
        for k in chaves:
            if k.get("type") == tipo and (tipo == "publishable" or k.get("name") == "anon"):
                return k["api_key"]
    return None


def ler_com_chave(chave, tabela):
    """Lê a tabela com a chave dada. Devolve (status, corpo); erro HTTP devolve corpo vazio."""
    cab = {"apikey": chave}
    if not chave.startswith("sb_"):
        cab["Authorization"] = "Bearer " + chave
    req = urllib.request.Request(ck.url_rest(URL) + tabela + "?select=*", headers=cab)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, []


@unittest.skipUnless(TEM_CREDENCIAL, "sem BARTE_ACADEMY_SUPABASE_URL/_SECRET_KEY: teste online pulado")
class BaseDoKitOnlineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contrato = ck.carregar_contrato()
        cls.linhas = ck.montar_linhas()
        cls.cliente = ck.Supabase(URL, CHAVE)

    def contagens(self):
        return {t["nome"]: self.cliente.contar(t["nome"]) for t in self.contrato["tabelas"]}

    def test_ac1_contagem_de_cada_tabela_igual_a_do_json(self):
        for t in self.contrato["tabelas"]:
            with self.subTest(tabela=t["nome"]):
                esperado = ck.contagem_esperada(t)
                obtido = self.cliente.contar(t["nome"])
                print(f"  AC-1 {t['nome']}: json={esperado} supabase={obtido}")
                self.assertEqual(esperado, obtido)

    def test_ac1_somas_conferem_com_o_json_sem_tolerancia(self):
        for t in self.contrato["tabelas"]:
            for coluna in t["somas"]:
                with self.subTest(tabela=t["nome"], coluna=coluna):
                    json_soma = ck.somar(self.linhas[t["nome"]], coluna)
                    banco = self.cliente.ler_coluna(t["nome"], coluna)
                    banco_soma = sum((ck.Decimal(str(v)) for v in banco), ck.Decimal(0))
                    print(f"  soma {t['nome']}.{coluna}: json={json_soma} supabase={banco_soma}")
                    self.assertEqual(json_soma, banco_soma)

    def test_ac2_carga_repetida_nao_muda_nenhuma_contagem(self):
        antes = self.contagens()
        ck.carregar(self.cliente)
        depois = self.contagens()
        print(f"  AC-2 antes={antes}\n  AC-2 depois={depois}")
        self.assertEqual(antes, depois)

    def test_ac3_chave_publica_nao_le_nenhuma_linha(self):
        publica = chave_publica()
        if not publica:
            self.skipTest("sem chave pública nem token para buscá-la")
        for t in self.contrato["tabelas"]:
            with self.subTest(tabela=t["nome"]):
                self.assertGreater(self.cliente.contar(t["nome"]), 0, "tabela vazia não prova RLS")
                status, corpo = ler_com_chave(publica, t["nome"])
                print(f"  AC-3 {t['nome']}: HTTP {status}, {len(corpo)} linhas")
                self.assertIn(status, (200, 401, 403))
                self.assertEqual([], corpo)


if __name__ == "__main__":
    unittest.main()
