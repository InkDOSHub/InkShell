# Roteiro de teste à mão: iPad A16 (XeOS) e iPhone Safari

Teste manual do terminal. Marque `[ ]` com `[x]` e preencha a tabela no fim.
Tudo aqui foi conferido em `app.js`, `index.html`, `overlay/` e `ROADMAP.md`; o que não dá p/ conferir no repo está marcado "(não verificado no repo)".

Convenções:
- Botões da barra do terminal (nomes do `index.html`): **Send a file**, **Files**, **Store**, **Mount a folder of this device**, **Save files now**, **Settings**, **About**. No ROADMAP o menu aparece como "☰" (a barra vem do Hub: `/assets/barra.js`, não está neste repo).
- Rede: Settings > Network = `wisp` (padrão) ou `No network`.
- `apk add` pede a senha (sudo): a que você criou no primeiro boot.
- Tela externa: só o iPad. iPhone faz os passos 1–11 e 15–17 que couberem; no iPhone o `/mnt` é só leitura (passo 12).

## Passos

1. [ ] **Abrir pelo Hub.** Hub → ícone Terminal (`/InkShell/`, em hub.inkdos.workers.dev). Esperado: barra "Alpine Linux", tela do terminal; no 1º uso pede criar usuário e senha.
2. [ ] **Tempo de boot.** Cronometre do toque no ícone até aparecer o prompt. Boot frio (1ª vez) e boot quente (fechar e abrir de novo). Anote os dois tempos. Se passar de 1 min, anote mesmo assim e não desista.
3. [ ] **Offline.** Com o terminal já aberto uma vez (passo 2 ok): modo avião → recarregar a página. Esperado: abre e chega no prompt sem rede. Os arquivos servidos com `?v=` (`app.js?v=`, `vendor/xterm.js?v=`) devem vir do cache HTTP do XeOS (immutable; não verificado no repo: o `sw.js` do projeto não faz cache). Se não abrir, anote a tela de erro. Depois: Settings > Network `No network` também deve ligar o terminal.
4. [ ] `uname -a` → esperado `Linux inksoc 6.1.0-inksoc #1 SMP InkSoC ... x86_64`.
5. [ ] `ls /` → esperado: `bin etc home usr var ...` (rootfs Alpine); `cat /etc/motd` mostra "Alpine Linux 3.21 on InkSoC".
6. [ ] **Pipe e redirect.** `echo ola | tr a-z A-Z > /tmp/a.txt; cat /tmp/a.txt; ls / | wc -l` → esperado `OLA` e um número.
7. [ ] **`help` e `bench`.** `help` mostra o guia. `bench` roda e imprime números (anote o resumo no campo nota).
8. [ ] **Loja.** Botão **Store** → escolher um item (ex.: `lua5.4`, `ripgrep`, `jq`, `sqlite`) → Install. Esperado: log de `apk add`, barra de `%` e texto "45% · 3,2 MB/s · 12 s" (% / velocidade / ETA, só aparece após ~2 s de dados). Anote se os 3 aparecem e se o ETA bate com o tempo real. Rede `wisp` precisa estar ligada. Equivalente no terminal: `sudo apk add NAME`.
9. [ ] **Python.** `python3 -c 'print(1)'` → `1`. Mede o tempo: `time python3 -c 'print(1)'` (1ª vez ~0,3 s; quente ~0,07 s no CI; no iPad anote o seu). Se faltar, `sudo apk add python3` (ou Store).
10. [ ] **sqlite3, jq, rg** (instalar pela Store ou `sudo apk add sqlite jq ripgrep`):
    - `sqlite3 /tmp/t.db 'create table x(a); insert into x values(1),(2); select sum(a) from x;'` → `3`
    - `echo '{"a":1}' | jq .a` → `1`
    - `echo ola mundo > /tmp/r.txt; rg mundo /tmp` → `/tmp/r.txt:ola mundo` (rg com 1 arquivo mostra só a linha)
11. [ ] **zip/unzip** (`sudo apk add zip unzip`): `cd /tmp && echo x > a && zip z.zip a && rm a && unzip z.zip && cat a` → `x`.
12. [ ] **Montar pasta do aparelho em /mnt.** Botão **Mount a folder of this device** → escolher uma pasta que tenha 1 arquivo grande (≥ 1 GB se tiver; senão ≥ 200 MB). Esperado: aviso `[/mnt/NOME: N files, changes go back to the folder]`. No iPhone/Safari sem seletor de pasta o aviso é `read-only` (esperado, não é falha).
    - [ ] `ls -l /mnt/NOME` mostra o tamanho certo do arquivo grande.
    - [ ] **Ler no meio sem puxar tudo:** `dd if=/mnt/NOME/GRANDE.bin bs=1M skip=100 count=4 2>/dev/null | sha256sum` e comparar com o mesmo trecho feito no computador (`dd ... | sha256sum`/`shasum -a 256`). Esperado: rápido (segundos) e hash igual.
    - [ ] `sha256sum /mnt/NOME/GRANDE.bin` (arquivo inteiro) confere com o hash do computador; anote o tempo. Pode demorar, o app não deve travar nem fechar sozinho.
    - [ ] **Escrever de volta:** `echo teste > /mnt/NOME/volta.txt` e `dd if=/dev/zero of=/mnt/NOME/z.bin bs=1M count=8`. Abrir o app Arquivos do aparelho: `volta.txt` e `z.bin` (8 MB) estão na pasta. Pode precisar de **Save files now**.
13. [ ] **Files / enviar.** **Send a file** manda um arquivo p/ a home (`ls ~`). **Files** abre o gerenciador; baixar um arquivo da home (ex.: o `z.zip` de /tmp, ou um arquivo criado em `~`).
14. [ ] **Persistência.** Criar `echo ficou > ~/p.txt`, **Save files now**, fechar a aba, abrir de novo: `cat ~/p.txt` → `ficou`.
15. [ ] **Teclado externo e atalhos.** Com teclado físico: digitar comandos, Enter (uma vez só, sem linha dupla), setas ↑/↓ (histórico), Tab (completa), Ctrl+C (interrompe `sleep 30`), Ctrl+D (sai de `cat`; `su`/`exit`). Na tela sem teclado físico: barra de teclas (esc, tab, ctrl, ^C, ^D, setas, `|`, `~`, `/`, `-`); `ctrl` + letra manda Ctrl+letra.
16. [ ] **Rotação e teclado virtual.** Girar o iPad/iPhone: o terminal reajusta colunas e linhas (rode `stty size` antes e depois, o valor muda). Abrir o teclado virtual: a barra de teclas fica acima dele e o prompt continua visível.
17. [ ] **Tela externa (só iPad).** Espelhar/estender na tela externa e abrir o terminal lá: o terminal ocupa a janela, `stty size` bate com o tamanho visível, o texto fica legível e a digitação (teclado físico) funciona.

## O que anotar se falhar

- O **comando exato** digitado (ou o botão tocado) e a mensagem que apareceu.
- O **tempo** (quanto esperou antes de desistir, ou quanto levou).
- Um **print** da tela inteira.
- Aparelho (iPad A16 / XeOS ou iPhone) e se a rede estava `wisp`, `No network` ou modo avião.

## Tabela de resultados

| Passo | ok/falhou | Tempo | Nota |
|---|---|---|---|
| 1 Abrir pelo Hub | | | |
| 2 Boot frio / quente | | | |
| 3 Offline (avião + recarregar) | | | |
| 4 uname -a | | | |
| 5 ls / | | | |
| 6 Pipe e redirect | | | |
| 7 help e bench | | | |
| 8 Loja (% / velocidade / ETA) | | | |
| 9 python3 | | | |
| 10 sqlite3 / jq / rg | | | |
| 11 zip / unzip | | | |
| 12 /mnt: listar, dd skip=, sha256sum, escrever de volta | | | |
| 13 Files / Send a file | | | |
| 14 Persistência | | | |
| 15 Teclado externo e atalhos | | | |
| 16 Rotação e teclado virtual | | | |
| 17 Tela externa | | | |
