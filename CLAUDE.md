# InkShell — regras p/ agente

Terminal Alpine Linux no navegador (iPad XeOS principal, iPhone Safari). Motor = InkSoC x86 (`engine-src/`) + kernel Linux (`engine-src/src/linux.rs`). `engine.wasm` commitado.

## Economia (obrigatório)
- Resposta caveman português. Commit/PR em inglês.
- Contexto: ler `docs/graph/SUMMARY.md` ANTES de abrir código. Abrir só arquivo/trecho necessário (grep + offset/limit).
- Nunca ler inteiro: `vendor/`, `engine.wasm`, `*.tar*`, `busybox`, `alpine/`, `engine-base.txt`, `linux.patch`.
- Testes SÓ no GitHub Actions (`test.yml`, `bench.yml`). Local: só `cargo check`/build e sintaxe (`node --check`).
- Sem código GPL no bundle. Sem fork/force-push.

## Threads
- **Gerente** (tarefa semanal ter 17:13 SP): mantém fila + pontos em `ROADMAP.md`, revisa, faz merge (ou libera auto-merge).
- **Worker**: 1 PR = 1 item (ou fatia). Branch `claude/<item>`, PR, espera CI verde. Após merge, se há cota na semana, segue p/ próximo item na mesma sessão (Paulo: semana inteira num dia ok).
  - Trabalho do terminal com CI verde = merge sozinho (squash). Hub UI continua pedindo Paulo.
- Worker termina com 2–4 linhas: PR, CI, pontos.

## Pontos
- Semana = ter 17:00 → ter 17:00 SP (renova o plano). Teto 30 pts/semana (Paulo). Fácil 1, médio 2, difícil 3,5.
- Conversão: 15 pts ≈ 20% do crédito semanal (1 pt ≈ 1,3%). Paulo informa o % real; se % real > pts × 1,3, valer o % real.
- Antes de começar: somar pontos da semana em `ROADMAP.md`; se estoura, parar e responder "sem cota".
- Registrar linha no quadro de pontos no mesmo PR.
- Fase estourou peso → último item da semana vai p/ seguinte.

## Chave do gerente
Antes de CADA item: `git fetch -q && git show origin/main:ROADMAP.md | grep ^CONTROLE:`. `PARAR` = parar já, sem novo commit. `seguir` = ok.

## Prioridade (custo-benefício)
- Razão = ganho estimado (%) ÷ pontos. Anotar ganho est. na fila antes; ganho medido depois.
- Diferença relativa entre as 2 melhores razões < 30% → escolher o que mais libera gargalo futuro. ≥ 30% → melhor razão. Empate → mais barato.
- Meta: terminal Linux decente p/ o InkDOS Hub no WebKit (XeOS/iPad, tela externa), offline, arquivos fatiados (pastas 12 GB, arquivos 10 GB sem RAM). WASM primeiro; x86-64 (InkSoC) reserva.

## Anti-insistência (consumo consciente)
Gastar só no que tira gargalo e deixa ganho duradouro.
- **Prova antes**: item de desempenho só começa com medida (bench/perfil) mostrando que ELE é o gargalo. Sem prova → item vira "medir X" (1 pt) primeiro.
- **Orçamento de rodadas**: cada item tem teto de rodadas de CI = 2 × pontos (1→2, 2→4, 3,5→7). Commit de debug no CI conta como rodada.
- **Sem ganho = não feito**: CI verde mas bench sem ganho medido → sem merge.
- **Estourou teto ou sem ganho** → PARAR. Item = `travado`. Nota no ROADMAP: o que tentou, número medido, hipótese de outro gargalo. Pontos gastos entram no quadro como `queimado` (contam no teto igual).
- **Trocar de frente**: depois de um `travado`, próximo item de OUTRO subsistema (ex.: JIT travou → terminal/WASM/instruções).
- **Retomar**: `travado` só volta com dado novo (perfil/outro item mudou o cenário) + aval do gerente. 1 retomada; falhou de novo = `descartado`.

## Ao mudar arquivos servidos
Bump query string: `engine.wasm?v=`, `worker.js?v=`, `app.js?v=`, `overlay.tar?v=`.

## Grafo
`graph.yml` (Actions) regera `docs/graph/SUMMARY.md` com graphify (AST, sem LLM). Rodar via workflow_dispatch se SUMMARY estiver velho (>20 commits).
