# Estudo 92 — shell em WASM para scripts (27/11, só medida e texto)

Pergunta: scripts `sh` poderiam rodar num shell WASM (laços, variáveis, builtins na velocidade do WASM) e chamar comandos externos pela ponte `/dev/inksoc` (itens 78/75/77a)? Item 88 (#131): ash x86 ≈ 60x nativo (laço de 1000 = 140 ms, `echo` x1000 = 180 ms, while-read de 100 linhas = 45 ms). Item 91 (#136): spawn de programa WASM na página = 40–55 ms (Worker por programa), busybox x86 = 1,2–2 ms.

**Resposta curta: NO-GO agora; GO condicional como programa opt-in (`dash` no catálogo) só depois que o spawn de WASM e de filho x86 pela ponte caírem (números na seção 6).** O shell WASM é 25–100x mais rápido no laço em si, mas hoje paga 40–55 ms só para começar e ~20 ms por comando externo; script típico (1 comando externo por volta) ficaria ~10x PIOR.

## 1. Candidatos

| Shell | Licença | Tamanho (estim.) | Caminho sem fork | Veredito |
|---|---|---|---|---|
| **dash 0.5.12** | BSD-3 (pode até ir no motor, mas vai como programa do catálogo) | 403 KB (medido, build abaixo) | só `vfork` p/ comando simples; `( )`, `$( )`, pipes, `&` chamam `fork()` | melhor base: pequeno, POSIX, rápido, estado dentro de poucas estruturas (variáveis, `localvars`, `savefd`, `jmploc`) fáceis de salvar/restaurar |
| busybox ash (NOMMU) | GPL-2.0 (só como programa separado, fonte na release) | ~1 MB com applets | único com modo sem fork de verdade: `BB_MMU=0` serializa o estado (`forkshell`) e re-executa o próprio binário; com `FEATURE_SH_STANDALONE`/NOFORK applets rodam DENTRO do shell (cat, echo, cut, sed... sem spawn) | mais compatível com scripts do Alpine (`${v//x}`, `echo -e`, `read -t`, `$RANDOM`) e é a única rota que também corta o spawn dos comandos pequenos; porte para WASI não existe pronto (fork, ioctl, termios, utmp): risco alto, não testado aqui |
| mrsh | MIT | pequeno | usa `fork` direto (não verificado em detalhe) | sem vantagem sobre dash |
| yash | GPL-2.0+ | maior | `fork` pesado, job control embutido | não |

Lacunas do dash frente ao ash do Alpine (scripts `#!/bin/sh` do Alpine são busybox ash): sem `${v//a/b}`, `$RANDOM`, `echo -e`, `read -n/-t`, `[[`. Script que usa isso quebra; precisaria de aviso ou lista de exceção.

## 2. Medido: dash em WASI (build local, não CI)
Build de viabilidade (wasi-sdk 25, clang 19, `-O2`, `-mexception-handling` + `-lsetjmp`; dash 0.5.12 compilado com um cabeçalho de atalhos: `fork`/`pipe`/`dup`/`kill`/`waitpid`/`sigaction`/`sigprocmask`/`getuid`... viram stubs, `-DSMALL` sem histedit, `ulimit` vazio; jobs/tty fora). Resultado: `dash.wasm` **402 900 bytes**, instancia em 1,5–2,5 ms, `setjmp` (usado nas exceções do dash) funciona como exceção WASM (mesmo mecanismo do bc/python3 do catálogo: exige exnref/EH no motor, igual item 89).

Tempos sob node 22 + `node:wasi` (1 processo, sem Worker por programa, sem service worker, sem ponte; 3 repetições; "run" = start do `_start` até sair, inclui o ~2 ms de início do shell). Comparar com o x86 do item 88 (Chromium, VM):

| Carga (item 88) | ash x86 (88) | dash WASM, total | dash WASM, só a parte do script (total − 2 ms vazio) | ganho total / do laço |
|---|---:|---:|---:|---:|
| laço `while [ $i -lt 1000 ]; i=$((i+1))` | 140 ms | 4,5–5,2 ms | ~2,8 ms | 28x / ~50x |
| laço de 100 000 voltas | (extrapolado 14 000 ms) | 130–149 ms | ~1,3 µs por volta | ~100x por volta (0,14 ms → 0,0013 ms) |
| `echo hi` x1000 (stdout p/ /dev/null do node) | 180 ms | 5,6–9,1 ms | ~5 ms | 20–32x |
| `echo hi` x100 000 | — | 184–198 ms | ~1,9 µs por volta | — |
| while-read de 100 linhas (stdin) | 45 ms | 2,7–3,0 ms | ~0,8 ms | 15x |
| `${s#abc}` `${t%%hij}` `case` x1000 | — | 6,2–6,4 ms | ~4,4 ms | — |

Ressalvas: (a) o motor é V8 do node, não a página; na página cada `fd_write` do `echo` vira chamada ao motor pelo wasi.js (custo não medido: o `echo` x1000 pode subir bem); (b) os tempos de "start" acima NÃO incluem o Worker por programa (40–55 ms, item 91); (c) 1 repetição de build, 3 execuções, medianas parecidas (±20%); (d) dash roda sem redirecionamento: `>file`/`<file` falharam no build de teste (ver 3).

O que NÃO funciona no build de viabilidade (esperado, medido com a mensagem do dash): `( echo x )` → `Cannot fork`; `x=$(echo hi)` → `Pipe call failed`; `echo hi | cat` → `Pipe call failed`; `/bin/true` → `Cannot fork`; `>arquivo`/`<arquivo` → `Invalid argument` (dash salva o fd com `fcntl(F_DUPFD)` ≥ 10 e usa `dup2`; WASI preview1 só tem `fd_renumber`).

## 3. Desenho sem fork
Meta: `sh script.sh` e `#!/bin/sh` rodando num dash WASM; o shell interativo (prompt, `Ctrl-C`, `fg`, `bg`, `jobs`) continua o ash x86 (sinais, grupos de processo e tty não existem em WASI).

| Construção | Como fazer no WASM | Custo/risco |
|---|---|---|
| comando externo simples | `compat_spawn` do 78 (op `spawn`, depois `wait`); filho x86 ou WASM, `stdin/stdout/stderr` = herdado/pipe/fd | hoje 20 ms (x86 pela ponte, medido no make 77a) e 40–55 ms (WASM); é o gargalo |
| `( cmd )` subshell | em processo: empilhar variáveis (já existe `localvars`), cwd, `umask`, `set -`, traps, fds (`savefd`) e rodar o corpo sob um `jmploc`; `exit` dentro = `longjmp` para o fim do subshell, restaura tudo | médio; ~300 linhas no `eval.c`; semântica quase igual (exceções: `kill $$`, `$BASHPID`, `trap ... EXIT` por subshell) |
| `$( cmd )` | igual ao subshell, com a saída capturada num buffer em memória (fd falso do wasi.js ou pipe do host) | médio; precisa de op nova `pipe` (memória) |
| `a \| b` com builtins | rodar `a` até o fim num buffer e depois `b` (sem coroutine); quebra `yes \| head`, `cat arq \| while read` com leitura parcial ainda ok | semântica diferente só com produtor infinito/interativo |
| `a \| b` com externos | 2 `spawn` ligados por um pipe do host (a ponte já devolve fds de pipe) | 2 spawns (20+20 ms hoje) |
| `cmd &` | externo: `spawn` sem `wait`; compound/função: re-exec de `dash -c CORPO` passando o estado (como o NOMMU do ash, `forkshell`) ou rodar síncrono (aviso) | fraco; `wait`, `$!` só p/ externos |
| `>`, `<`, `2>&1`, `exec 3<` | wasi.js precisa de `dup`/`fcntl(F_DUPFD)` (hoje só `fd_renumber`); op nova ou import `inksoc.dup` | pequeno, obrigatório |
| sinais, `trap`, job control, `read` com timeout | `trap EXIT` ok em processo; `trap INT` não chega; `kill -STOP/fg/bg` fora | aceitar como fora |
| `ulimit`, `umask` | `umask` = host; `ulimit` fora | — |

Esforço do dash: tirar `jobs.c` (controle de jobs), reescrever `forkshell`/`forkchild` de `jobs.c` para o modo em processo, `vforkexec` → `compat_spawn`, `pipe()` → op host, `dup`/`fcntl` → op host.

## 4. Quanto custa o spawn muda tudo
Modelo (ms): `x86 = 2 + 0,14·B + 2·E` e `WASM = S + 0,0013·B + X·E`, com B = voltas de builtin, E = comandos externos, S = início do shell WASM (hoje 40–55, item 91), X = comando externo pela ponte (hoje ~20 para filho x86, medido no make 77a: 50 receitas = 980 ms; 40–55 para filho WASM).

Ponto de equilíbrio sem externos (E = 0): `B* = (S − 2) / 0,139`.

| S (início do shell WASM) | B* (voltas de builtin para empatar) | equivale a um script de |
|---|---:|---|
| 50 ms (hoje) | 345 | 48 ms de ash x86 |
| 25 ms (pool de Workers, estimativa do 91) | 165 | 23 ms |
| 10 ms (pool + Module em cache) | 58 | 8 ms |

Com externos, cada comando externo custa `X − 2` ms a mais que no x86 (2 ms do busybox) e cada volta de builtin economiza 0,139 ms. Cada externo precisa de `(X − 2) / 0,139` voltas de builtin para compensar:

| X (externo pela ponte) | voltas de builtin por comando externo para empatar |
|---|---:|
| 55 ms (WASM hoje) | 380 |
| 20 ms (x86 pela ponte hoje) | 130 |
| 10 ms | 58 |
| 5 ms | 22 |
| 2 ms | 0 (igual ao x86) |

Exemplos: `for f in *; do grep x $f | cut -d: -f1; done` com 100 arquivos: x86 ≈ 100 × (0,14 + 2×2) = 0,4 s; shell WASM hoje ≈ 50 + 100 × 2 × 20 = 4 s (10x pior); item 88 "50x cut" 112 ms no busybox x86 → ~1 s com `cut` busybox pela ponte (9x pior). Já um script de contas/strings com 10 000 voltas e 1 externo: x86 ≈ 1,4 s, WASM hoje ≈ 70 ms (20x melhor). O ganho só aparece em script de cálculo/parse em shell puro; script que "cola" comandos perde.

## 5. Recomendação
**NO-GO agora** (não abrir o porte). **GO condicional**, como programa opt-in do catálogo (`apk add dash`, rodar com `dash script.sh` ou `#!/usr/bin/env dash`), nunca trocando o `sh` do sistema, e SÓ quando as 2 condições do item 91/seguinte forem medidas:

1. início de programa WASM na página (S) ≤ ~12 ms: pool de Workers pré-aquecidos + `WebAssembly.Module` em cache passado ao Worker (não recopiar os bytes do .wasm, item 91 alvo 2) + Worker que sobrevive entre filhos;
2. comando externo x86 pela ponte (X) ≤ ~5 ms medido separado do shell: hoje é um `spawn` que faz fork do stub x86 + ida e volta JSON pela ponte; uma op única `run` (spawn + wait + status/saída capturada numa volta só) corta 2–3 idas e vindas, e é o que `$( )` precisa.

Com S ≈ 10 e X ≈ 5 o ponto de equilíbrio é B* ≈ 58 voltas e 22 voltas por externo: aí o shell WASM empata em script comum e ganha 20–100x em laço. Sem isso, perde.
Alternativa de maior retorno que NÃO precisa shell novo: busybox em WASM com applets dentro do shell (rota ash NOMMU/`FEATURE_SH_STANDALONE`, GPL-2.0 separado) corta spawn dos comandos pequenos; porte grande e incerto, 5+ pts, não recomendado antes do pool.

Pontos (para a fila, ganho est. / pts): 
- 93 `run` na ponte + pool de Workers (continuação do 91; pré-requisito; ganho: spawn WASM 55 → ~12 ms, x86 pela ponte 20 → ≤ 5 ms; 3 pts; vale por si, vários itens do catálogo ganham).
- 94 dash opt-in (só se 93 entregar S ≤ 12, X ≤ 5): dash 0.5.12 com subshell/`$( )`/pipe em processo, `dup` e `pipe` no host, teste Linux leve + 1 comparativo (laço 1000 e 50 `cut`): 3,5 pts, 7 rodadas de CI; ganho est. 20–100x em scripts de shell puro, 0 em scripts de cola.
- Medir antes (1 pt, 2 rodadas): X puro (spawn busybox x86 pela ponte, 1000 vezes) e custo de `fd_write` do wasi.js por `echo`; é o que falta para fechar o modelo.

## 6. Como reproduzir o build de viabilidade (local)
wasi-sdk 25 (`wasi-sdk-25.0-x86_64-linux`), dash 0.5.12: `./configure && make` nativo só para gerar `builtins.c`, `nodes.c`, `syntax.c`, `signames.c`, `builtins.h`...; depois cada `.c` com `clang --sysroot=...wasi-sysroot -O2 -DHAVE_CONFIG_H -DSHELL -DSMALL -mexception-handling -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID` com um cabeçalho de atalhos incluído (`-include`), mais `bltin/test.c`, `bltin/printf.c`, `bltin/times.c` e um `ext.c` com `_isalnum`... e `ulimitcmd`; ligar com `-lsetjmp -lwasi-emulated-*`. Rodar com um `node:wasi` de 15 linhas medindo `compile`, `instantiate` e `start`. Nada disso entra no repositório (item só de estudo).
