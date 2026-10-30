// Dicionário: chave = texto em português → { en, id }. Textos que o backend (Rust) devolve prontos em português.
export default {
  // erros e avisos gerais (commands.rs, cmd_*.rs, registry.rs, state.rs)
  'Varredura cancelada.': { en: 'Scan canceled.', id: 'Pemindaian dibatalkan.' },
  'App não encontrado. Atualize a lista de apps.': { en: 'App not found. Refresh the app list.', id: 'Aplikasi tidak ditemukan. Muat ulang daftar aplikasi.' },
  'mantido porque o app não pôde ser removido': { en: 'kept because the app could not be removed', id: 'dipertahankan karena aplikasi tidak dapat dihapus' },
  'não foi confirmado como parte do app na verificação final': { en: 'was not confirmed as part of the app in the final check', id: 'tidak dikonfirmasi sebagai bagian dari aplikasi pada pemeriksaan akhir' },
  'o app dono deste cache está aberto; feche-o e tente de novo': { en: 'the app that owns this cache is open; quit it and try again', id: 'aplikasi pemilik cache ini sedang terbuka; tutup lalu coba lagi' },
  'Outra cópia deste app está instalada': { en: 'Another copy of this app is installed', id: 'Salinan lain aplikasi ini terpasang' },
  'A operação foi interrompida de forma inesperada.': { en: 'The operation was interrupted unexpectedly.', id: 'Operasi terhenti secara tak terduga.' },
  'Não foi possível ler a capacidade do disco: {e}': { en: 'Couldn’t read the disk capacity: {e}', id: 'Tidak dapat membaca kapasitas disk: {e}' },
  'Não foi possível ler a Lixeira: {e}': { en: 'Couldn’t read the Trash: {e}', id: 'Tidak dapat membaca Tempat Sampah: {e}' },
  'Arquivos relacionados': { en: 'Related files', id: 'File terkait' },
  'Preferências, caches e dados de suporte deixados pelo app.': { en: 'Preferences, caches and support data left behind by the app.', id: 'Preferensi, cache, dan data pendukung yang ditinggalkan aplikasi.' },
  'Feche o app antes de desinstalar.': { en: 'Quit the app before uninstalling it.', id: 'Tutup aplikasi sebelum menghapus instalasinya.' },
  'Um componente deste app (ajudante ou extensão) está em execução. Feche o app e tente de novo.': { en: 'A component of this app (helper or extension) is running. Quit the app and try again.', id: 'Komponen aplikasi ini (pembantu atau ekstensi) sedang berjalan. Tutup aplikasi lalu coba lagi.' },
  'O macOS não conseguiu abrir o item.': { en: 'macOS could not open the item.', id: 'macOS tidak dapat membuka item tersebut.' },
  'Não foi possível executar o comando de abertura: {e}': { en: 'Couldn’t run the open command: {e}', id: 'Tidak dapat menjalankan perintah pembuka: {e}' },
  'O item não existe mais no disco.': { en: 'The item no longer exists on disk.', id: 'Item tidak ada lagi di disk.' },
  'O app não existe mais no disco.': { en: 'The app no longer exists on disk.', id: 'Aplikasi tidak ada lagi di disk.' },
  'Ainda não há registro de ações.': { en: 'There is no action log yet.', id: 'Belum ada catatan tindakan.' },
  'Não foi possível salvar os ajustes: {e}': { en: 'Couldn’t save the settings: {e}', id: 'Tidak dapat menyimpan pengaturan: {e}' },
  'Não foi possível salvar a lista de ignorados: {e}': { en: 'Couldn’t save the ignored list: {e}', id: 'Tidak dapat menyimpan daftar item yang diabaikan: {e}' },
  'Não foi possível localizar a pasta pessoal do usuário.': { en: 'Couldn’t locate the user home folder.', id: 'Tidak dapat menemukan folder rumah pengguna.' },

  // apps (cmd_apps.rs)
  'Nenhuma atualização conhecida para este app. Analise de novo.': { en: 'No known update for this app. Scan again.', id: 'Tidak ada pembaruan yang diketahui untuk aplikasi ini. Pindai lagi.' },
  'O endereço da atualização não é seguro.': { en: 'The update address is not secure.', id: 'Alamat pembaruan tidak aman.' },

  // Visualização Rápida (cmd_cleanup.rs, cmd_lens.rs)
  'Não foi possível abrir a Visualização Rápida: {e}': { en: 'Couldn’t open Quick Look: {e}', id: 'Tidak dapat membuka Quick Look: {e}' },

  // locais (cmd_clutter.rs)
  'Local desconhecido. Atualize a lista de locais.': { en: 'Unknown location. Refresh the list of locations.', id: 'Lokasi tidak dikenal. Muat ulang daftar lokasi.' },
  'O local escolhido não está mais disponível.': { en: 'The chosen location is no longer available.', id: 'Lokasi yang dipilih sudah tidak tersedia.' },

  // Disk Map (cmd_lens.rs)
  'Local não encontrado. Atualize a lista.': { en: 'Location not found. Refresh the list.', id: 'Lokasi tidak ditemukan. Muat ulang daftar.' },
  'Nenhum mapa disponível. Analise o espaço de novo.': { en: 'No map available. Scan the space again.', id: 'Tidak ada peta yang tersedia. Pindai ruang lagi.' },
  'Item desconhecido. Analise o espaço de novo.': { en: 'Unknown item. Scan the space again.', id: 'Item tidak dikenal. Pindai ruang lagi.' },
  'Não foi possível ler este local.': { en: 'Couldn’t read this location.', id: 'Tidak dapat membaca lokasi ini.' },
  'Nenhum dos itens selecionados pode ser removido.': { en: 'None of the selected items can be removed.', id: 'Tidak ada item yang dipilih yang dapat dihapus.' },
  'Este item não tem uma pasta própria para visualizar.': { en: 'This item has no folder of its own to preview.', id: 'Item ini tidak memiliki folder sendiri untuk dipratinjau.' },
  'Itens selecionados': { en: 'Selected items', id: 'Item yang dipilih' },
  'Serão movidos para o Lixo; dá para restaurá-los de lá.': { en: 'They will be moved to the Trash, and you can restore them from there.', id: 'Item akan dipindahkan ke Tempat Sampah dan dapat dipulihkan dari sana.' },
  'Não foi possível ler o iCloud Drive: {e}': { en: 'Couldn’t read iCloud Drive: {e}', id: 'Tidak dapat membaca iCloud Drive: {e}' },

  // desempenho (cmd_perf.rs)
  'Agentes em segundo plano': { en: 'Background agents', id: 'Agen latar belakang' },
  'Agentes de inicialização do usuário.': { en: 'User launch agents.', id: 'Agen peluncuran pengguna.' },
  'Não foi possível listar os itens de login.': { en: 'Couldn’t list the login items.', id: 'Tidak dapat menampilkan daftar item login.' },
  'Não foi possível listar os snapshots locais.': { en: 'Couldn’t list the local snapshots.', id: 'Tidak dapat menampilkan daftar snapshot lokal.' },
  'falha interna': { en: 'internal failure', id: 'kegagalan internal' },
  'Agente não encontrado. Analise de novo para atualizar a lista.': { en: 'Agent not found. Scan again to refresh the list.', id: 'Agen tidak ditemukan. Pindai lagi untuk memperbarui daftar.' },
  'o arquivo do agente mudou desde a análise': { en: 'the agent file changed since the scan', id: 'berkas agen berubah sejak pemindaian' },
  'Não foi possível alterar o agente: {e}.': { en: 'Couldn’t change the agent: {e}.', id: 'Tidak dapat mengubah agen: {e}.' },
  'item de login desconhecido; analise de novo': { en: 'unknown login item; scan again', id: 'item login tidak dikenal; pindai lagi' },

  // proteção (cmd_security.rs)
  'Esta verificação não tem um painel nos Ajustes do Sistema.': { en: 'This check has no pane in System Settings.', id: 'Pemeriksaan ini tidak memiliki panel di Pengaturan Sistem.' },
  'permissão desconhecida; atualize a lista': { en: 'unknown permission; refresh the list', id: 'izin tidak dikenal; muat ulang daftar' },
  'Não foi possível ler as permissões dos apps: {why}': { en: 'Couldn’t read the apps\' permissions: {why}', id: 'Tidak dapat membaca izin aplikasi: {why}' },
  'o {name} está aberto; feche-o e tente de novo': { en: '{name} is open; quit it and try again', id: '{name} sedang terbuka; tutup lalu coba lagi' },
  'navegador': { en: 'browser', id: 'peramban' },

  // registro (registry.rs)
  'item desconhecido': { en: 'unknown item', id: 'item tidak dikenal' },
  'restos de app só podem ser removidos pela desinstalação do app': { en: 'app leftovers can only be removed by uninstalling the app', id: 'sisa aplikasi hanya dapat dihapus melalui penghapusan instalasi aplikasi' },
  'item não pertence a este app': { en: 'item does not belong to this app', id: 'item bukan milik aplikasi ini' },
  'arquivos do iCloud só podem ser removidos do Mac pela opção de desincronizar': { en: 'iCloud files can only be removed from the Mac using the unsync option', id: 'file iCloud hanya dapat dihapus dari Mac melalui opsi hentikan sinkronisasi' },
  'item não pertence a esta análise': { en: 'item does not belong to this scan', id: 'item bukan milik pemindaian ini' },
  'itens de privacidade só podem ser removidos pela tela de Privacidade': { en: 'privacy items can only be removed from the Privacy screen', id: 'item privasi hanya dapat dihapus dari layar Privasi' },
};
