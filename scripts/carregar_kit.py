#!/usr/bin/env python3
"""Carga idempotente de data/kit/*.json nas tabelas kit_ do Supabase.

A transformação (JSON -> linhas por tabela) é pura e não toca a rede. A carga grava pela API
PostgREST com upsert na chave primária, então rodar duas vezes não muda nenhuma contagem.

Variáveis de ambiente: BARTE_ACADEMY_SUPABASE_URL e BARTE_ACADEMY_SUPABASE_SECRET_KEY.
Nunca imprime a chave nem os cabeçalhos da requisição.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DADOS = os.path.join(RAIZ, "data", "kit")
LOTE = 500
VAR_URL = "BARTE_ACADEMY_SUPABASE_URL"
VAR_CHAVE = "BARTE_ACADEMY_SUPABASE_SECRET_KEY"


def url_rest(url):
    return url.rstrip("/") + "/rest/v1/"


class ErroDeCarga(Exception):
    pass


def ler_json(dados, nome):
    with open(os.path.join(dados, nome), encoding="utf-8") as f:
        return json.load(f, parse_float=Decimal)


def carregar_contrato(dados=DADOS):
    return ler_json(dados, "contrato.json")


def registros_do_arquivo(tabela, fonte):
    """Os registros de nível mais alto do arquivo, na forma de lista."""
    regra = tabela["contagem"]["regra"]
    if regra == "objeto_unico":
        return [fonte]
    if regra == "chaves_do_objeto":
        return [{"codigo": k, "descricao": v} for k, v in fonte.items()]
    return fonte


def contagem_esperada(tabela, dados=DADOS):
    """Contagem que o contrato manda: registros, soma dos itens, 1 ou número de chaves."""
    fonte = ler_json(dados, tabela["arquivo"])
    registros = registros_do_arquivo(tabela, fonte)
    if tabela["contagem"]["regra"] == "itens":
        return sum(len(r[tabela["contagem"]["campo"]]) for r in registros)
    return len(registros)


def linhas_de_itens(t, registros, colunas):
    """Uma linha por item de cada pai; o que o item não tem vem do pai."""
    campo = t["contagem"]["campo"]
    return [{c: item[c] if c in item else pai.get(c) for c in colunas}
            for pai in registros for item in pai[campo]]


def montar_linhas(dados=DADOS):
    """Devolve {tabela: [linha, ...]} na ordem do contrato (pais antes dos filhos)."""
    contrato = carregar_contrato(dados)
    linhas = {}
    for t in contrato["tabelas"]:
        colunas = [c["nome"] for c in t["colunas"]]
        fonte = ler_json(dados, t["arquivo"])
        registros = registros_do_arquivo(t, fonte)
        linhas[t["nome"]] = []
        if t["contagem"]["regra"] == "itens":
            linhas[t["nome"]] = linhas_de_itens(t, registros, colunas)
        elif t["nome"] == "kit_regua":
            linhas[t["nome"]].append({c: 1 if c == "id" else fonte[c] for c in colunas})
        else:
            for r in registros:
                linhas[t["nome"]].append({c: r.get(c) for c in colunas})
    return linhas


def somar(linhas, coluna):
    return sum((Decimal(str(l[coluna])) for l in linhas), Decimal(0))


def _serializar(linhas):
    # Decimal vai como texto JSON, sem passar por float; o PostgREST converte para numeric.
    class Codificador(json.JSONEncoder):
        def default(self, o):
            if isinstance(o, Decimal):
                return str(o)
            return super().default(o)
    return json.dumps(linhas, cls=Codificador, ensure_ascii=False).encode("utf-8")


class Supabase:
    """Cliente mínimo da API PostgREST. Não registra cabeçalhos."""

    def __init__(self, url, chave):
        self.base = url_rest(url)
        self.chave = chave

    def _pedir(self, metodo, caminho, corpo=None, extra=None):
        cab = {"apikey": self.chave, "Content-Type": "application/json"}
        if not self.chave.startswith("sb_"):
            cab["Authorization"] = "Bearer " + self.chave
        cab.update(extra or {})
        req = urllib.request.Request(self.base + caminho, data=corpo, method=metodo, headers=cab)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()
        except urllib.error.URLError as e:
            raise ErroDeCarga(f"{caminho.split('?')[0]}: falha de rede ({type(e.reason).__name__})") from None

    def gravar(self, tabela, linhas, pk):
        consulta = "?on_conflict=" + urllib.parse.quote(",".join(pk))
        extra = {"Prefer": "resolution=merge-duplicates,return=minimal"}
        for i in range(0, len(linhas), LOTE):
            status, _, _ = self._pedir("POST", tabela + consulta, _serializar(linhas[i:i + LOTE]), extra)
            if status >= 300:
                raise ErroDeCarga(f"{tabela}: HTTP {status} ao gravar")

    def contar(self, tabela):
        status, cab, _ = self._pedir("GET", tabela + "?select=*", None,
                                     {"Prefer": "count=exact", "Range": "0-0", "Range-Unit": "items"})
        if status >= 300:
            raise ErroDeCarga(f"{tabela}: HTTP {status} ao contar")
        return int({k.lower(): v for k, v in cab.items()}["content-range"].split("/")[1])

    def ler_coluna(self, tabela, coluna):
        """Lê uma coluna inteira, paginando. Números voltam como Decimal."""
        valores, inicio = [], 0
        while True:
            status, _, corpo = self._pedir(
                "GET", f"{tabela}?select={coluna}&order={coluna}", None,
                {"Range": f"{inicio}-{inicio + 999}", "Range-Unit": "items"})
            if status >= 300:
                raise ErroDeCarga(f"{tabela}: HTTP {status} ao ler")
            pagina = json.loads(corpo, parse_float=Decimal)
            valores += [p[coluna] for p in pagina]
            if len(pagina) < 1000:
                return valores
            inicio += 1000


def carregar(cliente, dados=DADOS):
    """Grava todas as tabelas, pais antes dos filhos. Devolve {tabela: linhas enviadas}."""
    contrato = carregar_contrato(dados)
    linhas = montar_linhas(dados)
    for t in contrato["tabelas"]:
        cliente.gravar(t["nome"], linhas[t["nome"]], t["chave_primaria"])
    return {n: len(l) for n, l in linhas.items()}


def cliente_do_ambiente(env=os.environ):
    url, chave = env.get(VAR_URL), env.get(VAR_CHAVE)
    if not url or not chave:
        raise ErroDeCarga(f"defina {VAR_URL} e {VAR_CHAVE}")
    return Supabase(url, chave)


def main():
    try:
        cliente = cliente_do_ambiente()
        enviadas = carregar(cliente)
        for tabela, n in enviadas.items():
            print(f"{tabela}: {n} linhas gravadas, {cliente.contar(tabela)} na tabela")
    except ErroDeCarga as e:
        print(f"erro: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
