# Limpaemeo

Limpeza de disco para macOS, com identidade visual própria. Engine em Rust (`crates/limpa-core`), shell Tauri 2 usando o WebKit do sistema (`src-tauri`) e interface em HTML/CSS/JS sem dependências (`ui`). O `.app` de release tem cerca de 5 MB.

## Módulos

- **Faxina** analisa lixo, Lixeira, apps e arquivos grandes de uma vez. "Executar" remove apenas o lixo pré-selecionado.
- **Limpeza** cobre caches e logs do usuário, lixo do Xcode e caches de gerenciadores de pacotes.
- **Lixeira** mostra o tamanho e esvazia a Lixeira, com confirmação.
- **Aplicativos** desinstala apps junto com os restos em `~/Library`.
- **Meus Arquivos** lista arquivos grandes na pasta pessoal, agrupados por tipo.

## Modelo de segurança

- A interface nunca envia caminhos de arquivo. O backend guarda o resultado de cada análise e entrega só ids numéricos, que nunca se repetem. Para remover, a interface devolve ids.
- Toda remoção passa de novo pelo `Guard` (`crates/limpa-core/src/guard.rs`) no momento em que acontece. O `Guard` exige caminho absoluto, sem `..`. Exige que o item esteja estritamente dentro da raiz permitida para a sua política. Recusa qualquer item que seja, ou que contenha, um local protegido (`/`, `~`, `~/Library`, `~/Documents` etc.). Nunca toca em `~/.ssh`, Keychains, iCloud Drive, Mail, Mensagens ou Fotos. Nunca segue symlinks.
- Cache e log regeneráveis são apagados direto, porque mandar para o Lixo não liberaria espaço. Arquivos do usuário, apps e restos vão para o Lixo pelo `NSFileManager`, então dá para recuperar. Esvaziar a Lixeira apaga definitivamente e pede confirmação.
- O app que está aberto é reconhecido pelo bundle id, pelo nome e por pastas de fornecedor (por exemplo `Caches/Google` para o Chrome). O cache dele vem desmarcado. Se o app for aberto depois da análise, a remoção desse cache é recusada.
- A identidade de cada item (dispositivo e inode) é registrada na análise. Se o caminho passar a apontar para outro arquivo, a remoção é recusada.
- Caches de downloads em andamento (sessões de URL em segundo plano, App Store, atualizações do macOS) e de serviços do iCloud, HomeKit e Buscar nunca entram na lista.
- Se houver outra cópia do mesmo app instalada, os restos vêm desmarcados.
- Caches caros de baixar de novo vêm desmarcados. Arquivos do usuário nunca vêm pré-selecionados.
- Cada ação fica registrada em `~/Library/Logs/Limpaemeo/actions.log` ("Ver log" na interface).
- Fica de fora de propósito:
  - remoção de idiomas e de binários universais, porque quebra assinaturas de código;
  - caches de sistema, porque exigem root;
  - "antimalware" sem base de assinaturas;
  - `~/Library/Containers` na limpeza, porque dispara alertas de privacidade.

## Permissões

Sem Acesso Total ao Disco o app funciona, mas não lê a Lixeira e parte de `~/Library`. Para conceder, vá em Ajustes do Sistema › Privacidade e Segurança › Acesso Total ao Disco. O build local é assinado ad hoc, então o macOS associa a permissão ao hash do binário. Depois de recompilar, é preciso conceder de novo.

## Desenvolvimento

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p limpaemeo            # abre o app servindo ./ui embutido
```

Requer Rust estável e `tauri-cli` 2.x (`cargo install tauri-cli --version '^2' --locked`).

## Instalação

```sh
scripts/install.sh
```

O script compila o bundle de release, copia para `~/Applications/Limpaemeo.app`, registra no LaunchServices e indexa no Spotlight. Ele termina com sucesso só quando o `mdfind` encontra o app.
