# InkShell roadmap

Fonte: "Roadmap do terminal Linux (a partir de sex 27/11)", Paulo, 2026-11-22.
Foco: terminal Linux sólido e rápido no WebKit. Ferramenta com WASM roda direto; x86 (InkSoC) só reserva. Arquivo nunca inteiro na RAM.

## Fila (gerente mantém; worker pega o primeiro `aberto`)

| # | Item | Fase | Pts | Estado | Pronto quando |
|---|---|---|---|---|---|
| 1 | Bench Linux em todo PR, números vs anterior | 1 | 1 | feito | PR mostra números lado a lado |
| 2 | Kernel roda .wasm WASI (arquivos, pipes, tty, /mnt) | 2 | 3,5 | feito (#17 + fatia 2: página c/ Worker + service worker, engine.wasm no CI). Pendente leve: caminho relativo resolve de / | .wasm roda no shell c/ pipe e redirect |
| 3 | Catálogo WASM + `apk add` consulta catálogo + loja ☰ (python3, coreutils, sqlite, ripgrep, jq, lua, zip/unzip) | 3 | 3,5 | aberto | python3 abre em WASM; bench bem > x86 |
| 4 | Disco Linux no OPFS em blocos; /mnt por File.slice; cache c/ descarte | 4 | 3,5 | aberto | copiar+zipar 1 GB no CI sem estourar memória |
| 5 | ffmpeg, 7z, qpdf, imagemagick WASM (sem GPL) | 5 | 2 | aberto | cada um roda WASM + teste curto |
| 6 | inkvideo (WebCodecs H.264/HEVC) | 6 | 2 | aberto | 1080p no iPhone em tempo real |

Item grande (3,5) pode ser fatiado pelo worker em sub-PRs; somar pontos por fatia.

## Semanas (14 pts; sex→qui)

| Sem | Datas | Plano | Pts |
|---|---|---|---|
| 1 | 23/11–03/12 (Paulo: assinatura nova, semana 0 vira semana 1) | Resto item 2; itens 3–6. Terminal pronto | 12,5 + 1,5 correções |
| 2 | 04/12–10/12 | x86: call/ret (2), rep movs/stos (1), BMI/POPCNT/LZCNT (2), SSE/x87 no JIT (3,5), bench x86 CI (1) | 9,5 + 4,5 |
| 3 | 11/12–17/12 | Opcional: cache JIT OPFS (2), Linux 32 bits (3,5), AVX/AVX2 (7) | até 12,5 |
| 4+ | 18/12– | Windows/exe: só pesquisa se Paulo pedir | — |

Metas: fim sem 1 → WASM 1,3–2x nativo, arquivo 10 GB sem estourar. Fim sem 2 → x86 ~3x nativo, call ~5x.

## Quadro de pontos

| Data | Sem | Item | PR | Pts |
|---|---|---|---|---|
| 2026-11-23 | 1 | Processo: CLAUDE.md, graph.yml, fila | — | 0 (infra) |
| 2026-11-23 | 1 | 1: bench em todo PR + comparação c/ main | #14 | 1 |
| 2026-11-23 | 1 | 2 fatia 1: exec .wasm → stub + wasi.js (WASI→Linux) + teste | #17 | 2 |
| 2026-11-23 | 1 | 2 fatia 2: .wasm na página (Worker + sw.js), engine.yml rebuild, teste Chromium | #19 | 1,5 |

## Fora (sem ponto até Paulo mandar)
Compat Windows InkSoC; Steam/CEF/jogos/instaladores; Wine WASM; JIT x86 antes do terminal; Blink; x86→WASM no aparelho; inkbuild/compilar git/ssh/gcc/node; apps gráficos, servidores, threads WASI; visual Hub/InkOS que não sirva o terminal.

## Backlog antigo (2026-11-20)
- Protocolo postMessage InkOS v1 (`docs/PROTOCOL.md`), validar origem pai.
- Rootfs como artefato de CI (componentes GPL-2.0 fora da árvore MIT).
- Tema via `assets/tema.js`.
