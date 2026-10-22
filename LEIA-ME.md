# Servidor do modo ao vivo (Cloudflare)

1. Instale o Wrangler e entre na sua conta Cloudflare:
   `npm i -g wrangler` e depois `wrangler login`
2. Dentro desta pasta, publique:
   `wrangler deploy`
   (o plano gratuito serve; as classes usam armazenamento SQLite dos Durable Objects)
3. O comando mostra um endereço parecido com `https://chicken-fight-live.SEU-USUARIO.workers.dev`.
   Cole esse endereço em `LIVE_SERVER` perto do fim do `index.html` e publique o jogo de novo.
4. Opcional: em `wrangler.toml`, tire o `#` de `[vars]` e `ORIGINS` e coloque o endereço do seu site
   para o servidor só aceitar conexões vindas dele.

Teste local da lógica da sala (sem Cloudflare): `node teste.mjs`

## Regras do servidor
- O servidor sorteia a luta (`sim.mjs`, mesma regra do jogo) e manda a lista de golpes; o celular só anima.
- Cada jogador tem uma carteira de moedas da arena (começa com 100; abaixo de 10 volta para 30), separada das moedas do jogo de um jogador.
- Apostas abrem por 30 s quando há dois treinadores. Taxa da casa de 5% sobre o lucro. Treinador não aposta.
- Prêmio dos treinadores: 30 para quem vence, 5 para quem perde.
- Os atributos do galo vêm do celular e o servidor só limita os exageros; para impedir trapaça de verdade, o próximo passo é guardar os galos na conta do servidor.
