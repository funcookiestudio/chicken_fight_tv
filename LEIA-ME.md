# Servidor da TV (Cloudflare)

1. `wrangler login` (uma vez) e, dentro desta pasta, `wrangler deploy`.
   A migração v2 cria o Canal e apaga as salas antigas da Arena (Room e Lobby). O plano gratuito serve.
2. Confira que `LIVE_SERVER` (em `<script>` perto do fim do `index.html`) tem o endereço do seu Worker,
   como `https://chicken-fight-live.SEU-USUARIO.workers.dev`, e publique o jogo de novo.
3. Opcional: em `wrangler.toml`, tire o `#` de `[vars]` e `ORIGINS` e coloque o endereço do seu site.

Teste local da lógica da emissora (sem Cloudflare): `node teste.mjs`

## Como funciona
- **Canal** é a emissora: uma instância só. Fica parada quando ninguém assiste nem tem inscrição e acorda sozinha
  quando alguém abre a TV ou se inscreve.
- Ciclo: apostas (30 s) → luta → resultado (14 s) → próxima. Quem assiste vê a mesma luta ao mesmo tempo.
- **Pareamento:** dois inscritos na mesma luta se enfrentam; se só houver um, ele luta contra o galo da casa;
  sem inscritos, a TV passa uma exibição casa x casa.
- **Inscrição** é feita no site do jogo (app Internet): taxa em moedas do jogo, uma inscrição por luta,
  vagas limitadas, cancelar antes de ser escalado devolve metade. O resultado e o prêmio chegam em "Minhas inscrições".
- **Apostas** da plateia são em sacas, feitas no próprio celular; as odds são as mesmas do servidor.
- **Replays:** o servidor guarda a semente das últimas 12 lutas e refaz a luta igual.
- Moedas e sacas valem só dentro do jogo.

## Limites conhecidos
- Os atributos do galo, a taxa e o prêmio são aplicados no celular; o servidor só limita os exageros nos atributos.
  Para impedir trapaça de verdade, o próximo passo é guardar os galos e as moedas na conta do servidor (a classe `Wallet` está reservada para isso).
- Sem limite de requisições por pessoa além das regras de inscrição.
