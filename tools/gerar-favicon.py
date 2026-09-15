# Gera o favicon do quadro. Rodar a mao quando o desenho mudar:
#
#   python -m pip install pillow
#   python tools/gerar-favicon.py
#
# POR QUE ESTE DESENHO: favicon se le a 16px, e o anterior era uma ilustracao do
# quadro inteiro -- moldura de janela e 25 cartoes, cada um com linhas de texto
# dentro. Otimo a 256px, mancha pastel a 16px: nenhuma daquelas formas chegava a
# existir no tamanho em que a coisa e realmente vista.
#
# Quatro quadrados resolvem porque sao QUATRO formas grandes em vez de trinta
# pequenas -- e ainda contam a historia do quadro: quase tudo bem, um pedindo
# atencao.
#
# O script vive aqui para o desenho nao virar um PNG orfao que ninguem sabe
# refazer. Desenha grande e reduz, que e o que deixa a borda limpa.

from PIL import Image, ImageDraw
from pathlib import Path

SAIDA = Path(__file__).resolve().parent.parent / "public"

VERDE    = "#17a15a"   # --ok-forte
VERMELHO = "#d8402f"   # --erro-forte
MARINHO  = "#0d2240"

S = 1024  # resolucao de desenho


def icone(cantos_redondos=True):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    raio = int(S * 0.22) if cantos_redondos else 0
    dr.rounded_rectangle([0, 0, S - 1, S - 1], radius=raio, fill=MARINHO)

    margem, vao = int(S * 0.155), int(S * 0.055)
    lado = (S - 2 * margem - vao) // 2
    # Tres verdes e um vermelho, o vermelho embaixo a direita: e para onde o
    # olho vai por ultimo, que e onde a excecao deve estar.
    for i, cor in enumerate((VERDE, VERDE, VERDE, VERMELHO)):
        x = margem + (i % 2) * (lado + vao)
        y = margem + (i // 2) * (lado + vao)
        dr.rounded_rectangle([x, y, x + lado, y + lado], radius=int(lado * 0.26), fill=cor)
    return im


def main():
    base = icone()
    for nome, tamanho in [("favicon.png", 256), ("favicon-64.png", 64),
                          ("favicon-32.png", 32), ("favicon-16.png", 16)]:
        base.resize((tamanho, tamanho), Image.LANCZOS).save(SAIDA / nome)
        print("  ", nome, f"{tamanho}x{tamanho}")

    # O do iOS vai SEM cantos arredondados e sem transparencia: o proprio sistema
    # recorta o icone, e um PNG que ja vem recortado ganha cantos pretos por cima.
    quadrado = icone(cantos_redondos=False).convert("RGB")
    quadrado.resize((180, 180), Image.LANCZOS).save(SAIDA / "apple-touch-icon.png")
    print("   apple-touch-icon.png 180x180 (sem cantos: o iOS recorta sozinho)")


if __name__ == "__main__":
    main()
