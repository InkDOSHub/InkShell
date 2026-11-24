# InkShell roadmap

CONTROLE: PARAR (sessões soltas; workers agora são subagentes do gerente)
SALDO: semana 1 (até ter 24/11 17:00): 31% gasto ≈ 23 pts de 30 → sobram ~7 pts.

Fonte: "Roadmap do terminal Linux (a partir de sex 27/11)", Paulo, 2026-11-22.
Foco: terminal Linux sólido e rápido no WebKit. Ferramenta com WASM roda direto; x86 (InkSoC) só reserva. Arquivo nunca inteiro na RAM.

## Fila (gerente mantém; worker pega o primeiro `aberto`)

| # | Item | Fase | Pts | Estado | Pronto quando |
|---|---|---|---|---|---|
| 1 | Bench Linux em todo PR, números vs anterior | 1 | 1 | feito | PR mostra números lado a lado |
| 2 | Kernel roda .wasm WASI (arquivos, pipes, tty, /mnt) | 2 | 3,5 | feito (#17 + fatia 2: página c/ Worker + service worker, engine.wasm no CI; caminho relativo segue a pasta do shell desde item 3 fatia 3) | .wasm roda no shell c/ pipe e redirect |
| 3 | Catálogo WASM + `apk add` consulta catálogo + loja ☰ (python3, coreutils, sqlite, ripgrep, jq, lua, zip/unzip) | 3 | 3,5 | feito (fatia 1 catálogo #21; fatia 2 python3 + bench #22; fatia 3 loja ☰ + caminho relativo). Sobra: catálogo só python3/ruby (coreutils, sqlite, ripgrep, jq, lua, zip/unzip sem build WASI pronto/licença conferida); `/` dentro de programa WASI mostra a pasta do shell e getcwd() diz `/`; loja sem barra de % do download | python3 abre em WASM; bench bem > x86 |
| 4 | Disco Linux no OPFS em blocos; /mnt por File.slice; cache c/ descarte | 4 | 3,5 | feito (fatia 1 #24: arquivo > 1 MB em blocos no swap OPFS, tar salvo em pedaços, pico wasm 2768 → 672 MB; fatia 2: extents de 64 KB = 1 chamada ao host por 16 blocos (host_swap_readv/writev), cache 4 MB c/ escrita sequencial saindo na hora, cp/ln compartilham extents (copy-on-write), boot lê o tar salvo em pedaços de 4 MB direto p/ blocos, `put` sobre arquivo em blocos devolve os blocos. Bench 1 GB (x nativo): cópia 4,4x → 0,0x (9 ms), criar 3,5x → 0,1x, zip 6,8x; pico wasm 655 MB. Sobra: /mnt ainda lê o arquivo inteiro (File.slice em pedaços), mmap de arquivo grande copia) | copiar+zipar 1 GB no CI sem estourar memória |
| 5 | ffmpeg, 7z, qpdf, imagemagick WASM (sem GPL) | 5 | 2 | feito (#28: wasm-tools.yml compila c/ wasi-sdk-33 e publica release wasm-tools-2; catálogo 7zip (7zz 24.08 sem unRAR, LGPL+BSD), qpdf 11.9.1 (Apache), imagemagick 7.1.1 (PNG/JPEG), ffmpeg+ffprobe 5.1.9 LGPL só codecs internos. Sobra: ffmpeg ≥6 precisa threads (WASI p1 não tem); sem x264/fontes; 1 thread; exceções wasm exnref = Safari ≥18.4) | cada um roda WASM + teste curto |
| 6 | inkvideo (WebCodecs H.264/HEVC) | 6 | 2 | aberto | 1080p no iPhone em tempo real |
| 7 | x86: rep movs/stos | x86 | 1 | em andamento (#27: string 11x → 4,3x nativo; falta CI verde) | CI verde + bench string melhor |
| 8 | x86: BMI/POPCNT/LZCNT | x86 | 2 | aberto | instruções testadas no CI |
| 9 | Bench x86 no CI (perfil: onde o tempo vai) | x86 | 1 | aberto | PR mostra perfil por bloco/instrução |
| 10 | x86: call/ret rápido no JIT | x86 | 2 | travado (#26, 6 queimado: região c/ ret/jmp indireto e registradores residentes sem ganho, calls 28–31x antes e depois; hipótese: gargalo fora do call/ret, ex. dispatcher/flags. Retomar só c/ perfil do item 9) | calls ≤ ~5x nativo |
| 11 | x86: SSE/x87 no JIT | x86 | 3,5 | aberto (precisa prova do item 9) | bench float melhor |

Ordem após item 7: 6 → 8 → 9 → pacotes catálogo → 11 → 10 (regra anti-insistência no CLAUDE.md).

Item grande (3,5) pode ser fatiado pelo worker em sub-PRs; somar pontos por fatia.

## Semanas (plano Pro renova toda terça 17:00 SP)

- Semana = ter 17:00 → ter 17:00 SP. Teto 14 pts de ter 17:00 até ter 10:00 seguinte.
- Ter 10:00 → 17:00: liberado, sem teto (queima o resto do crédito; linhas "reserva" no quadro).
- Worker nunca espera horário: item pronto → merge → próximo item, até o teto.

| Sem | Datas | Plano | Pts |
|---|---|---|---|
| 1 | seg 23/11 → ter 24/11 17:00 (curta; ter 10–17 liberado) | Item 1; começo item 2 | até 14 |
| 2 | 24/11 → 01/12 | Resto item 2; itens 3–6. Terminal pronto | 12,5 + 1,5 correções |
| 3 | 01/12 → 08/12 | x86: call/ret (2), rep movs/stos (1), BMI/POPCNT/LZCNT (2), SSE/x87 no JIT (3,5), bench x86 CI (1) | 9,5 + 4,5 |
| 4 | 08/12 → 15/12 | Opcional: cache JIT OPFS (2), Linux 32 bits (3,5), AVX/AVX2 (7) | até 12,5 |
| 5+ | 15/12 → | Windows/exe: só pesquisa se Paulo pedir | — |

Metas: fim sem 2 → WASM 1,3–2x nativo, arquivo 10 GB sem estourar. Fim sem 3 → x86 ~3x nativo, call ~5x.

## Quadro de pontos

| Data | Sem | Item | PR | Pts |
|---|---|---|---|---|
| 2026-11-23 | 1 | Processo: CLAUDE.md, graph.yml, fila | — | 0 (infra) |
| 2026-11-23 | 1 | 1: bench em todo PR + comparação c/ main | #14 | 1 |
| 2026-11-23 | 1 | 2 fatia 1: exec .wasm → stub + wasi.js (WASI→Linux) + teste | #17 | 2 |
| 2026-11-23 | 1 | 2 fatia 2: .wasm na página (Worker + sw.js), engine.yml rebuild, teste Chromium | #19 | 1,5 |
| 2026-11-23 | 1 | correção: 🔺 do bench pelo "x nativo" | #20 | 0,5 |
| 2026-11-23 | 1 | 3 fatia 1: catálogo WASM + apk add | #21 | 2 |
| 2026-11-23 | 1 | 3 fatia 2: python3 WASM roda + bench | #22 | 2 |
| 2026-11-23 | 1 | 3 fatia 3: loja ☰ + caminho relativo | #23 | 1 |
| 2026-11-23 | 1 | 4 fatia 1: arquivo grande em blocos (swap OPFS) + cache + tar em pedaços | #24 | 2 |
| 2026-11-23 | 1 | 4 fatia 2: extents 64 KB (I/O em lote), restaurar tar em pedaços sem RAM, cp copy-on-write, vazamento do put | #25 | 1,5 |
| 2026-11-23 | 1 | 5: ferramentas WASM (7zip, qpdf, imagemagick, ffmpeg/ffprobe) (extra Paulo) | #28 | 2 |
| 2026-11-23 | 1 | 10: x86 call/ret sem ganho (travado; insistência ~6 pts reais) | #26 | 6 (queimado) |

## Fora (sem ponto até Paulo mandar)
Compat Windows InkSoC; Steam/CEF/jogos/instaladores; Wine WASM; JIT x86 antes do terminal; Blink; x86→WASM no aparelho; inkbuild/compilar git/ssh/gcc/node; apps gráficos, servidores, threads WASI; visual Hub/InkOS que não sirva o terminal.

## Backlog antigo (2026-11-20)
- Protocolo postMessage InkOS v1 (`docs/PROTOCOL.md`), validar origem pai.
- Rootfs como artefato de CI (componentes GPL-2.0 fora da árvore MIT).
- Tema via `assets/tema.js`.
