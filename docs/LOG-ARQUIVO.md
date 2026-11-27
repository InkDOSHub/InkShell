# Log antigo do gerente

Linhas tiradas da seção 10 de `docs/GERENTE.md` para a sessão não carregar o histórico inteiro.
A mais nova fica em cima. Formato: `AAAA-MM-DD | #PR | item | resultado curto | próximo passo`

- 2026-11-27 | #128 | 85 jq com oniguruma | jq 1.7.1 + oniguruma 6.9.10 (BSD-2) estático, `wasm-tools-36` só com jq.wasm; test/match/capture/sub/gsub/scan/splits funcionam | próximo: 77 clang + make
- 2026-11-27 | #129 | 86 Pillow extras no python WASM | `wasm-tools-37` (python3 30,9 MB): FreeType 2.13.3 (FTL), libwebp 1.5.0, libtiff 4.7.0; setjmp = exceção wasm (exnref) → JPEG ruim dá OSError e o python segue; `wasmtime wizer` 44 no lugar do pack do wasi-vfs; `fix_meth.py` conserta getextrema/split/abrir WEBP (trap no wasm, bug do 84 também); início do python (node, 1 rep, compile + `import PIL.Image`) 394 → 321 ms, resize LANCZOS 30 ms; 1 build + 1 rodada de teste | 77 clang + make
- 2026-11-27 | #123 | 71 diffutils + patch GNU em WASM | wasm-tools-30 (diff, cmp, diff3, sdiff 3.12) e -31 (patch 2.8.1, sem fchmodat); GPL-3.0 como programas separados, fonte nas releases; `apk add diffutils` traz cmp/diff3/sdiff; Chromium 10 MB: diff 13398 -> 225 ms (59x), diff -u 102x, cmp 36x, sem abort (uutils dava 134) | 77 clang + make
- 2026-11-27 | #126 | 84 Pillow no python WASM | python3 do catálogo religado (`wasm-tools-34`): libpython 3.12.0 da VMware + Pillow 11.3.0 (módulos C embutidos, WASI sem dlopen) + libjpeg-turbo 3.0.4, wasi-sdk 20, wasi-vfs 0.4.0, wasm-opt -O2; PNG/JPEG abrir/salvar, resize, thumbnail, convert no teste Linux leve; resize 1024²→512² LANCZOS 36 ms WASM vs 16 ms nativo (2,3x); script inteiro ~1,2 s; 1 rodada de CI; rede/processos/pip do python seguem no teste | 71 diff / 77 clang
- 2026-11-27 | — | troca de gerente | sessão 013qXTaN assume; #123 (71) parado sem CI desde 00:27 (configure do diffutils em cross-compile) retomado; dono: sem limite de crédito hoje, ≥2 em paralelo | 71 + 84 em paralelo, depois 77
- 2026-11-26 | #120 | 83 pip no python WASM | catálogo py3-pip = wheel pip 26.3 do PyPI (MIT), vem com `apk add python3`; adaptador requests sobre http.client pela ponte do 76; instala em ~/.local; `pip`/`pip3`/`python3 -m pip`; `pip install six` + import no teste Linux leve; só wheel Python puro (sem compilador) | 71 diff
- 2026-11-26 | #119 | 75 git em WASM | wasm-tools-29 só com git (28 = 1º build sem uso) 2.47.1 (4,1 MB, GPL-2.0 como programa separado, fonte na release); start_command pela ponte /dev/inksoc (compat_spawn); init/add/commit/status/log/diff/branch/switch/merge ff e 3-way/tag/mv/rm/show/reset num processo; stash por filhos; sem clone https (`apk add --x86 git`); add+commit 500 arquivos 1,05 s; 5 rodadas de CI | 83 pip
- 2026-11-26 | #118 | 82 curl em WASM | wasm-tools-27 só com curl.wasm (cliente próprio compatível com curl, MIT, 374 KB; 26 = 1º build sem uso) pela ponte de rede do 76 (/dev/tcp + inksoc-net, TLS no ssl_client); -o -O -L -s -I -i -H -X -d -f -w...; códigos de saída do curl; teste Linux leve (busybox httpd local + https example.com); sem FTP/-F/proxy/HTTP2 | 75 git
- 2026-11-26 | #117 | 81 nano em WASM | wasm-tools-25 só com nano 8.3 (1,0 MB, GPL-3.0 como programa separado; fontes de nano e ncurses na release); ncurses 6.5 estático com xterm-256color embutido, termios/tamanho pelos imports `inksoc`; ASCII, sem corretor, sem `^T`; teste Linux leve (digitar, Ctrl-O Enter, Ctrl-X); 3 rodadas de CI | 82 curl
- 2026-11-26 | #113 | 74 vim em WASM | wasm-tools-24 só com vim (Vim 9.1.1400, licença Vim, 3,7 MB), `apk add vim` = vim/vi/view; build de 1ª, teste Linux leve (abrir, G o texto Esc :wq); :! ainda sem fork (reporta falha); tty pelos imports `inksoc` do 73 | 73 less (#106), 75 git
- 2026-11-26 | #116 | 80 grep GNU em WASM | wasm-tools-23 só com grep 3.12 + fonte (GPL-3.0 como programa separado, catálogo aceita GPL só p/ grep); grep/egrep/fgrep antes do busybox; 10,9 MB: 216–400x vs busybox x86 (Chromium); 2 rodadas de CI | 81 nano
- 2026-11-26 | #115 | fila por uso | ordem do dono: vim, grep, nano, curl, git, pip, diff, clang, Pillow | 80 grep
- 2026-11-26 | #106 | 73 less em WASM | merge com aval do dono ("autorizo quebrar a regra teto de rodadas no 73"), 3ª rodada verde; less 692 completo, teclas sem Enter, janela; sem ganho de velocidade (4 → 32 ms) | 74 vim
- 2026-11-26 | #114 | fazer completo, testar 1x no fim | WIP com [skip ci], teste tolerante | —
- 2026-11-26 | #112 | 79 qjs com ponte de processos | wasm-tools-22 só com qjs; std.popen e os.exec (bloqueante) pela ponte, filho WASM direto; teste leve procs.sh | semana 4
- 2026-11-26 | #109 | 78 ponte de processos WASM | canal /dev/inksoc (spawn/wait/kill); python subprocess/os.system, awk/lua/find -exec; filho WASM direto; py sort 2571 → 694 ms vs x86 python, find -exec 200 195 → 182 ms | 79: só quickjs
- 2026-11-26 | #111 | prompt de início | seção 0 com prompt pronto p/ sessão nova | —
- 2026-11-26 | #110 | regra troca de agente | qualquer agente/conta continua: push a cada passo, PR com "Estado p/ continuar" | —
- 2026-11-26 | #108 | manual do gerente | este arquivo criado | 78 rodando, depois 79
- 2026-11-26 | #107 | 76 rede no python WASM | urllib http/https via ajudante x86 | 78 no mesmo worker
- 2026-11-26 | #105 | regra | até 2 itens simples em paralelo | —
- 2026-11-26 | #104 | 69 hash /mnt Chromium | cota do OPFS checada; hash 3 GB certo | —
- 2026-11-26 | #103 | 72 bc/file | bc 55–213x; file novo | —
