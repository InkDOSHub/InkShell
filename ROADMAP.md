# InkShell roadmap

CONTROLE: seguir (sessão oficial do gerente 24/11; uma sessão por vez)
SALDO: semana 1 (até ter 24/11 17:00): 31% gasto ≈ 23 pts de 30 → sobram ~7 pts.
Paulo 24/11: sem teto até ter 24/11 16:59; teto 30 a partir de ter 17:09.

Fonte: "Roadmap do terminal Linux (a partir de sex 27/11)", Paulo, 2026-11-22.
Foco: terminal Linux sólido e rápido no WebKit. Ferramenta com WASM roda direto; x86 (InkSoC) só reserva. Arquivo nunca inteiro na RAM.

## Fila (gerente mantém; worker pega o primeiro `aberto`)

| # | Item | Fase | Pts | Estado | Pronto quando |
|---|---|---|---|---|---|
| 1 | Bench Linux em todo PR, números vs anterior | 1 | 1 | feito | PR mostra números lado a lado |
| 2 | Kernel roda .wasm WASI (arquivos, pipes, tty, /mnt) | 2 | 3,5 | feito (#17 + fatia 2: página c/ Worker + service worker, engine.wasm no CI; caminho relativo segue a pasta do shell desde item 3 fatia 3) | .wasm roda no shell c/ pipe e redirect |
| 3 | Catálogo WASM + `apk add` consulta catálogo + loja ☰ (python3, coreutils, sqlite, ripgrep, jq, lua, zip/unzip) | 3 | 3,5 | feito (fatia 1 catálogo #21; fatia 2 python3 + bench #22; fatia 3 loja ☰ + caminho relativo). Sobra: coreutils GNU fora (GPL; busybox cobre); sqlite, jq, lua, zip/unzip entraram no #36 (item 14); ripgrep e cwd real do programa WASI entraram no #38 (item 16); barra de % na loja entrou no #40 (item 18) | python3 abre em WASM; bench bem > x86 |
| 4 | Disco Linux no OPFS em blocos; /mnt por File.slice; cache c/ descarte | 4 | 3,5 | feito (fatia 1 #24: arquivo > 1 MB em blocos no swap OPFS, tar salvo em pedaços, pico wasm 2768 → 672 MB; fatia 2: extents de 64 KB = 1 chamada ao host por 16 blocos (host_swap_readv/writev), cache 4 MB c/ escrita sequencial saindo na hora, cp/ln compartilham extents (copy-on-write), boot lê o tar salvo em pedaços de 4 MB direto p/ blocos, `put` sobre arquivo em blocos devolve os blocos. Bench 1 GB (x nativo): cópia 4,4x → 0,0x (9 ms), criar 3,5x → 0,1x, zip 6,8x; pico wasm 655 MB. Sobra: /mnt ainda lê o arquivo inteiro (File.slice em pedaços), mmap de arquivo grande copia) | copiar+zipar 1 GB no CI sem estourar memória |
| 5 | ffmpeg, 7z, qpdf, imagemagick WASM (sem GPL) | 5 | 2 | feito (#28: wasm-tools.yml compila c/ wasi-sdk-33 e publica release wasm-tools-2; catálogo 7zip (7zz 24.08 sem unRAR, LGPL+BSD), qpdf 11.9.1 (Apache), imagemagick 7.1.1 (PNG/JPEG), ffmpeg+ffprobe 5.1.9 LGPL só codecs internos. Sobra: ffmpeg ≥6 precisa threads (WASI p1 não tem); sem x264/fontes; 1 thread; exceções wasm exnref = Safari ≥18.4) | cada um roda WASM + teste curto |
| 6 | inkvideo (WebCodecs H.264/HEVC) | 6 | 2 | feito (#31: `inkvideo info/decode/transcode/selftest` roda como programa JS no Worker WASI (módulo-marcador `inkshell.js` em /usr/local/libexec), WebCodecs da página c/ hardware preferido; MP4/MOV (avcC/hvcC) e Annex B lidos em pedaços; sem WebCodecs sai 69 e decode cai p/ ffmpeg. Sobra: medir 1080p no iPhone; saída de transcode é .h264/.265 cru (sem mux MP4); sem escala/resize) | 1080p no iPhone em tempo real |
| 7 | x86: rep movs/stos | x86 | 1 | feito (#30, refeito de #27 sem o #26: string 11x → 4,3x nativo; + munmap agora descommita (acesso depois = SIGSEGV, antes virava página zerada) e MAP_FIXED recommita) | CI verde + bench string melhor |
| 8 | x86: BMI/POPCNT/LZCNT | x86 | 2 | feito (#32: VEX BMI1/BMI2 + CPUID leaf 7, teste x86bmi) | instruções testadas no CI |
| 9 | Bench x86 no CI (perfil: onde o tempo vai) | x86 | 1 | feito (#33: motor `--features ophist` à parte no bench.yml, tests/bench/profile.mjs → resumo do job + comentário do PR. PERFIL: calls (fib, ~27x nativo, ~110 ms) roda 100% no JIT, 65 instr/bloco, só ~1M voltas ao dispatcher, 0 fallback; 32% das saídas por ret/indireto; custo está dentro do código JIT (8,6M loads + 7,7M stores p/ 62M instr = push/pop/ret pela memória), não no dispatcher/flags → item 10 só volta mirando acesso à pilha. float (~8x) também 100% JIT, 0 fallback, 0 opcode interpretado → item 11 sem prova (SSE já está no JIT; lentidão é a qualidade do código). Gargalo real = sort (14x, ~20 s): 351M fallbacks dentro do JIT (movsb 241M, movs 60M, shl/shr cl 32M, tzcnt 15M) + 416M saídas por rip calculado (99% das execuções de bloco)) | PR mostra perfil por bloco/instrução |
| 10 | x86: call/ret rápido no JIT | x86 | 2 | travado (#26, 6 queimado: região c/ ret/jmp indireto e registradores residentes sem ganho, calls 28–31x antes e depois; hipótese: gargalo fora do call/ret, ex. dispatcher/flags. Retomar só c/ perfil do item 9) | calls ≤ ~5x nativo |
| 11 | x86: SSE/x87 no JIT | x86 | 3,5 | aberto (precisa prova do item 9) | bench float melhor |
| 12 | x86 JIT: fallbacks do sort (movs, shift cl, tzcnt) | x86 | 2 | feito (#34: sort 19,7x → 10,4x nativo (main re-medido); instr. interpretadas no sort 351M → 2,4M (shld/shrd); contador de fallback 62,6M = REP movs que roda rep_bulk num passo sem sair do bloco. Próximo: 416M saídas por rip calculado = ret/call indireto (comparador do qsort, memcpy) → encadear ret com pilha-sombra) | sort melhor no bench |
| 13 | /mnt por File.slice (leitura em pedaços) | 4 | 2 | feito (#35: arquivo > 1 MB do /mnt vira arquivo em blocos do tamanho real; leitura pede só a faixa (extents 64 KB, pedaço até 4 MB c/ read-ahead) e a página responde com File.slice; escrita/truncate/link/exec buscam o arquivo inteiro em pedaços (p/ swap) antes. Sobra: escrita ainda regrava o arquivo inteiro na página (createWritable em pedaços não feito); download pelo Files de arquivo grande do /mnt lê pela página) | arquivo grande do /mnt sem ler inteiro |
| 14 | Catálogo: sqlite, jq, lua, zip/unzip, ripgrep (WASM, sem GPL) | 3 | 2 | feito (#36: release wasm-tools-3 = wasm-tools-2 + sqlite3 3.47.2 (2,0 MB, modo WASI do próprio sqlite: sem WAL/extensões, trava por arquivo-ponto), jq 1.7.1 (1,0 MB, sem oniguruma = sem test/match/sub), lua 5.4.7 (0,7 MB, erros por setjmp wasm; sem popen/execute/tmpfile), zip 3.0 (0,6 MB) e unzip 6.0 (0,5 MB) Info-ZIP sem bzip2 (termios falso, mkstemp no compat; horário UTC). 5 rodadas (1 acima do teto): linha do terminal longa demais p/ o catálogo local; /tmp/z já usado. ripgrep 14.1.1 compilou (rg.wasm 3,4 MB na wasm-tools-3) e rodou no CI (busca em pasta, rc=1, pipe com `-`), mas o teste esperava saída sem cor (tty → cor) e o teto de 4 rodadas estourou → fora do catálogo neste PR. Sobra: ripgrep = só linha no catálogo + teste c/ `--color never` (pipe só com `-`: em WASI o rg não detecta stdin legível); jq c/ oniguruma; unzip 6.0 sem os patches de CVE do Debian (roda no sandbox WASM); bench WASM x x86 dessas ferramentas não medido) | cada um roda WASM + teste |
| 15 | /mnt: teste na página, escrita em pedaços, download de arquivo grande | 4 | 2 | feito (#37: teste da página no Chromium monta pasta c/ arquivo de 64 MB pelos 2 caminhos reais — handle (OPFS, como showDirectoryPicker) via mountDir e input de pasta via mountFiles — e confere dd skip no meio + sha256sum; escrita de volta: arquivo > 1 MB vai p/ a pasta em pedaços de 4 MB (createWritable + write({position}), página puxa do worker, linux_get_range), msync em fila; download pelo worker de arquivo grande do /mnt ainda não lido: worker lê em pedaços (busca os que faltam na página) e entrega Blob. Sobra: escrita regrava o arquivo todo (em pedaços), não só os extents mudados) | página lê/grava arquivo grande do /mnt em pedaços |
| 16 | ripgrep no catálogo + cwd real em programa WASI | 3 | 2 | feito (#38: rg 14.1.1 da wasm-tools-3 no catálogo, teste c/ `--color never` (pasta, -c/-n/-l, rc=1, stdin só com `-`); wasi.js acha o ponteiro de cwd da wasi-libc (palavra dos dados que aponta p/ "/" e aparece como i32.const no código) e, se acha 1, preopen "/" = raiz real e aponta o cwd p/ a string PWD= que environ_get escreve na memória do programa: python3 getcwd = pasta do shell, `/` = raiz real. Sobra: rg/jq (sem chdir na wasi-libc ou ponteiro não achado) seguem no modo antigo ("/" = pasta do shell + preopen por pasta do topo); programa que não lê environ fica com cwd `/`) | rg roda; getcwd = pasta do shell |
| 17 | cache da detecção de cwd WASI | 3 | 1 | feito (#39: detecção 218 ms → 14 ms na 2ª execução em diante (só o hash do módulo); cache por conteúdo (tamanho + 2 hashes 32 bits): Map em wasi.js (inline) + Map em app.js repassado a cada Worker; sem persistência em disco (1ª execução por página ainda paga); py.* do bench sem piora além do ruído) | python3 sem custo extra por execução |
| 18 | loja ☰: % do download + gravação em pedaços | 3 | 1 | feito (#40: o download não passa pela página: é wget/cp do `apk` no Linux (rede pelo wisp), gravando direto no disco Linux (arquivo > 1 MB em blocos no swap OPFS, item 4) — nada junta num ArrayBuffer da página; sha256sum lê o arquivo do disco. `apk` passa o download por dd (até 2 MB por vez, sem sleep: sleep ≥ 0,6 s parece ocioso p/ o settle do linux-test, rodada 1 falhou assim) e escreve `NOME: 12/25 MB 48%` com \r no terminal (tty) e p/ a loja (INKSOC_PROGRESS no inksoc-store); loja lê o log e mostra `<progress>` + % na mensagem. Sobra: % por tamanho do arquivo, sem velocidade/ETA; Remover sem barra (é instantâneo)) | barra chega a 100%, download sem juntar na RAM |
| 19 | medir abertura do python3 WASM | 3 | 1 | feito (#41: `python3 -c pass` 133 ms quente / 290 ms frio (nativo 11): fork+execve 7, leitura .wasm 4, detecção cwd 38 com cache (só hash de 25 MB; 11–41 ms, frio 131), resto setup 10, compilação 17 (frio 22; sem cache de Module), instanciação 7, chamadas WASI 286 = 2 ms (desprezível), Python puro 47 (frio 103; inclui compilação preguiçosa do V8), exit 10 fora; `-S` 37 e `-I` 42 de Python puro → site.py ≈ 10 ms; gargalo = Python dentro do wasm + recompilação do Module a cada execução + hash do módulo) | perfil no PR |
| 20 | cache do Module WASM compilado + chave barata do cwd | 3 | 2 | feito (#42: py-start quente 134 → 66 ms (x nativo 11 → 5,5): compilação 17 → 0 (cache do Module por versão do arquivo no kernel, `wasi_module_gen`), detecção cwd 38 → 0, Python puro 48 → 39 (V8 mantém funções já compiladas); `-S` 98 → 43, `-I` 104 → 47; frio 286 → 216. Página: app.js guarda 4 Modules e passa ao Worker novo por postMessage (sem IndexedDB). Sobra: instanciação 7, resto setup 10, Python puro 39) | python3 -c pass quente mais rápido |
| 21 | unzip c/ patches de CVE + teste de invalidação do cache de Module | 3 | 2 | feito (#N: unzip 6.0 + 26 patches Debian 6.0-28 em tools/wasm-tools/patches/unzip (licença Info-ZIP, sem GPL): CVE-2014-8139/8140/8141, 2014-9636, 2014-9913, 2015-7696/7697, 2016-9844, 2018-1000035, 2019-13232, 2022-0529/0530; release wasm-tools-4 (só unzip compilado, resto copiado da 3); linux-test: zip com 2 entradas sobrepostas → unzip sai 12 "possible zip bomb"; cache: sqlite3 2× (2ª = hit), jq gravado por cima (mesmo tamanho/caminho) → roda jq, chave nova) | zip malicioso recusado; Module novo após regravar |

Recomendação (item 19): próximo item WASI = cache do `WebAssembly.Module` compilado por chave (mesmo Module reusado no node/worker; na página, Module guardado no worker do motor/IndexedDB e passado ao Worker do programa) + chave do cwd por caminho+tamanho+mtime do kernel em vez do hash de 25 MB. Ganho est.: compilação 17 + hash 11–38 + parte da compilação preguiçosa dentro do "Python puro" → 133 → ~60–75 ms (~45%), 2 pts. Medir antes com o Module reusado (bench pystart já mostra as fases). Ler o .wasm 2× (execve + wasi_module) custa só ~4 ms: não atacar.

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
| 2026-11-23 | 1 | 7: x86 rep movs/stos em lote (refeito sobre main) | #30 | 1 |
| 2026-11-24 | 1 | 6: inkvideo WebCodecs + fallback | #31 | 2 |
| 2026-11-24 | 1 | 8: x86 BMI1/BMI2/POPCNT/LZCNT/TZCNT + teste | #32 | 2 |
| 2026-11-24 | 1 | 9: perfil x86 no CI (JIT/interp/opcodes) | #33 | 1 |
| 2026-11-24 | 1 | 12: JIT sem fallback p/ movs/shift cl/tzcnt | #34 | 2 |
| 2026-11-24 | 1 | 13: /mnt lê em pedaços (File.slice) | #35 | 2 |
| 2026-11-24 | 1 | 14: catálogo sqlite/jq/lua/zip/unzip (rg compilado, fora: teto de rodadas) | #36 | 2 |
| 2026-11-24 | 1 | 15: /mnt página + escrita em pedaços | #37 | 2 |
| 2026-11-24 | 1 | 16: ripgrep + cwd WASI | #38 | 2 |
| 2026-11-24 | 1 | 17: cache detecção cwd WASI | #39 | 1 |
| 2026-11-24 | 1 | 18: loja % do download | #40 | 1 |
| 2026-11-24 | 1 | 19: perfil da abertura do python3 WASM | #41 | 1 |
| 2026-11-24 | 1 | 20: cache Module WASM + chave cwd | #42 | 2 |
| 2026-11-24 | 1 | 21: unzip CVE + teste cache Module | #N | 2 |

## Fora (sem ponto até Paulo mandar)
Compat Windows InkSoC; Steam/CEF/jogos/instaladores; Wine WASM; JIT x86 antes do terminal; Blink; x86→WASM no aparelho; inkbuild/compilar git/ssh/gcc/node; apps gráficos, servidores, threads WASI; visual Hub/InkOS que não sirva o terminal.

## Backlog antigo (2026-11-20)
- Protocolo postMessage InkOS v1 (`docs/PROTOCOL.md`), validar origem pai.
- Rootfs como artefato de CI (componentes GPL-2.0 fora da árvore MIT).
- Tema via `assets/tema.js`.
