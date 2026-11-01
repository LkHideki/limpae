// Dictionary: key = Portuguese text → { en, id }.
// Texts that arrive ready-made from the backend (limpa-core: junk, large, clutter, remove, guard). Used via `tr`.
export default {
  // junk.rs — junk groups
  'Cache do usuário': { en: 'User cache', id: 'Cache pengguna' },
  'Arquivos temporários que os apps recriam automaticamente.': { en: 'Temporary files that apps recreate automatically.', id: 'File sementara yang dibuat ulang otomatis oleh app.' },
  'Logs do usuário': { en: 'User logs', id: 'Log pengguna' },
  'Registros de diagnóstico de apps e do sistema.': { en: 'Diagnostic records from apps and the system.', id: 'Catatan diagnostik dari app dan sistem.' },
  'Lixo de IA': { en: 'AI junk', id: 'Sampah AI' },
  'Caches e logs de ferramentas de IA, além de modelos locais que ocupam muito espaço.': { en: 'Caches and logs from AI tools, plus local models that take up a lot of space.', id: 'Cache dan log dari alat AI, serta model lokal yang memakai banyak ruang.' },
  'Lixo do Xcode': { en: 'Xcode junk', id: 'Sampah Xcode' },
  'Dados de build e suporte a dispositivos que o Xcode recria.': { en: 'Build data and device support files that Xcode recreates.', id: 'Data build dan dukungan perangkat yang dibuat ulang oleh Xcode.' },
  'Caches de desenvolvimento': { en: 'Developer caches', id: 'Cache pengembangan' },
  'Pacotes baixados por gerenciadores como npm, Homebrew e pip.': { en: 'Packages downloaded by managers such as npm, Homebrew and pip.', id: 'Paket yang diunduh oleh pengelola seperti npm, Homebrew, dan pip.' },
  'Preferências corrompidas': { en: 'Corrupted preferences', id: 'Preferensi rusak' },
  'Arquivos de preferência ilegíveis; o app cria um novo na próxima abertura.': { en: 'Unreadable preference files; the app creates a new one the next time it opens.', id: 'File preferensi yang tidak dapat dibaca; app membuat yang baru saat dibuka berikutnya.' },
  'Itens de login quebrados': { en: 'Broken login items', id: 'Item login rusak' },
  'Agentes de login que apontam para um executável que não existe mais.': { en: 'Login agents that point to an executable that no longer exists.', id: 'Agen login yang menunjuk ke file eksekusi yang sudah tidak ada.' },
  'Backups de iPhone e iPad': { en: 'iPhone and iPad backups', id: 'Cadangan iPhone dan iPad' },
  'Cópias de dispositivos feitas pelo Finder; vão para o Lixo.': { en: 'Device backups made by Finder; they go to the Trash.', id: 'Cadangan perangkat yang dibuat oleh Finder; dipindahkan ke Tempat Sampah.' },
  'Anexos do Mail': { en: 'Mail attachments', id: 'Lampiran Mail' },
  'Cópias de anexos que o Mail baixa de novo quando você os abre.': { en: 'Attachment copies that Mail downloads again when you open them.', id: 'Salinan lampiran yang diunduh ulang oleh Mail saat Anda membukanya.' },

  // junk.rs — item notes
  'Modelo local; baixe de novo se precisar': { en: 'Local model; download it again if needed', id: 'Model lokal; unduh ulang jika diperlukan' },
  'Necessário para símbolos de depuração': { en: 'Needed for debug symbols', id: 'Diperlukan untuk simbol debug' },
  'Backup mais recente': { en: 'Most recent backup', id: 'Cadangan terbaru' },
  'Modificado depois de baixado; pode ser a única cópia': { en: 'Modified after download; may be the only copy', id: 'Diubah setelah diunduh; mungkin satu-satunya salinan' },
  'Cache de módulos; o próximo build fica mais lento': { en: 'Module cache; the next build will be slower', id: 'Cache modul; build berikutnya akan lebih lambat' },
  'Grande para baixar de novo': { en: 'Large to download again', id: 'Berukuran besar untuk diunduh ulang' },
  'App em execução': { en: 'App is running', id: 'App sedang berjalan' },
  'Executável ausente: {path}': { en: 'Missing executable: {path}', id: 'File eksekusi tidak ditemukan: {path}' },

  // large.rs — large-file categories
  'Vídeos': { en: 'Videos', id: 'Video' },
  'Filmes e gravações que costumam ocupar muito espaço.': { en: 'Movies and recordings that tend to take up a lot of space.', id: 'Film dan rekaman yang biasanya memakan banyak ruang.' },
  'Arquivos compactados': { en: 'Compressed files', id: 'File terkompresi' },
  'Pacotes que talvez você já tenha extraído.': { en: 'Packages you may have already extracted.', id: 'Paket yang mungkin sudah Anda ekstrak.' },
  'Imagens de disco': { en: 'Disk images', id: 'Image disk' },
  'Instaladores e imagens que costumam ficar esquecidos.': { en: 'Installers and images that tend to be forgotten.', id: 'Penginstal dan image yang biasanya terlupakan.' },
  'Áudio': { en: 'Audio', id: 'Audio' },
  'Músicas e gravações de áudio grandes.': { en: 'Large music and audio recordings.', id: 'Musik dan rekaman audio berukuran besar.' },
  'Outros': { en: 'Other', id: 'Lainnya' },
  'Outros arquivos grandes na sua pasta pessoal.': { en: 'Other large files in your home folder.', id: 'File besar lainnya di folder pribadi Anda.' },

  // clutter.rs — duplicates, similar images, downloads, volumes
  'Original sugerido': { en: 'Suggested original', id: 'Asli yang disarankan' },
  'Melhor qualidade': { en: 'Best quality', id: 'Kualitas terbaik' },
  '{n} cópias · {size} cada': { en: '{n} copies · {size} each', id: '{n} salinan · masing-masing {size}' },
  '{n} imagens parecidas': { en: '{n} similar images', id: '{n} gambar serupa' },
  '1 arquivo': { en: '1 file', id: '1 file' },
  '{n} arquivos': { en: '{n} files', id: '{n} file' },
  'Pasta pessoal': { en: 'Home folder', id: 'Folder rumah' },

  // remove.rs — errors and Trash
  'autorização cancelada; o item continua no lugar': { en: 'authorization canceled; the item stays in place', id: 'otorisasi dibatalkan; item tetap di tempatnya' },
  'cancelado; o item continua no lugar': { en: 'canceled; the item was left in place', id: 'dibatalkan; item tetap di tempatnya' },
  'sem permissão: o item pertence ao sistema ou a outro usuário': { en: 'no permission: the item belongs to the system or another user', id: 'tidak ada izin: item milik sistem atau pengguna lain' },
  'não foi possível mover para o Lixo ({detail})': { en: 'could not move to the Trash ({detail})', id: 'tidak dapat dipindahkan ke Tempat Sampah ({detail})' },
  'sem permissão para remover este item': { en: 'no permission to remove this item', id: 'tidak ada izin untuk menghapus item ini' },
  'o item não existe mais': { en: 'the item no longer exists', id: 'item sudah tidak ada' },
  'o item está em uso; tente de novo': { en: 'the item is in use; try again', id: 'item sedang digunakan; coba lagi' },
  'Lixeira': { en: 'Trash', id: 'Tempat Sampah' },
  'Itens que você já descartou. Esvaziar apaga definitivamente.': { en: 'Items you have already discarded. Emptying deletes them permanently.', id: 'Item yang sudah Anda buang. Mengosongkan akan menghapusnya secara permanen.' },

  // guard.rs — refusal reasons
  'caminho não é absoluto': { en: 'path is not absolute', id: 'path bukan path absolut' },
  "caminho contém '..' ou '.'": { en: 'path contains \'..\' or \'.\'', id: 'path mengandung \'..\' atau \'.\'' },
  'item não existe mais': { en: 'item no longer exists', id: 'item sudah tidak ada' },
  'local protegido': { en: 'protected location', id: 'lokasi terlindungi' },
  'dentro de área proibida': { en: 'inside a restricted area', id: 'berada di dalam area terlarang' },
  'fora da área permitida': { en: 'outside the allowed area', id: 'di luar area yang diizinkan' },
  'raiz de limpeza inválida': { en: 'invalid cleanup root', id: 'akar pembersihan tidak valid' },
  'o item mudou desde a análise; analise de novo': { en: 'the item changed since the scan; scan again', id: 'item berubah sejak pemindaian; pindai ulang' },
};
