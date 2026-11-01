// Dictionary: key = Portuguese text → { en, id }.
// Backend texts (perf.rs, health.rs, security*.rs) shown via tr(); keys with {param} match the rendered text.
export default {
  // ---- health.rs: health level
  'Excelente': { en: 'Excellent', id: 'Sangat baik' },
  'Boa': { en: 'Good', id: 'Baik' },
  'Regular': { en: 'Fair', id: 'Cukup' },
  'Requer atenção': { en: 'Needs attention', id: 'Perlu perhatian' },
  'Crítica': { en: 'Critical', id: 'Kritis' },

  // ---- health.rs: factors
  'Disco quase cheio': { en: 'Disk almost full', id: 'Disk hampir penuh' },
  'Pouco espaço livre no disco': { en: 'Low free disk space', id: 'Ruang disk kosong menipis' },
  'Restam {free} de {total} ({pct} %). Libere espaço para o Mac não ficar lento.': {
    en: '{free} of {total} left ({pct}%). Free up space so your Mac doesn’t slow down.',
    id: 'Tersisa {free} dari {total} ({pct}%). Kosongkan ruang agar Mac Anda tidak melambat.',
  },
  'Liberar espaço': { en: 'Free up space', id: 'Kosongkan ruang' },
  'Lixeira cheia': { en: 'Trash is full', id: 'Tempat Sampah penuh' },
  'A Lixeira ocupa {size}. Esvaziar devolve esse espaço.': {
    en: 'The Trash is using {size}. Emptying it gives that space back.',
    id: 'Tempat Sampah memakai {size}. Mengosongkannya akan mengembalikan ruang tersebut.',
  },
  'Esvaziar Lixeira': { en: 'Empty Trash', id: 'Kosongkan Tempat Sampah' },
  'Executar Faxina': { en: 'Run Sweep', id: 'Jalankan Sapu Bersih' },
  'Nenhuma Faxina ainda': { en: 'No Sweep yet', id: 'Belum ada Sapu Bersih' },
  'Você ainda não fez uma Faxina neste Mac.': {
    en: 'You haven’t run a Sweep on this Mac yet.',
    id: 'Anda belum menjalankan Sapu Bersih di Mac ini.',
  },
  'Faz tempo desde a última limpeza': { en: 'It’s been a while since the last cleanup', id: 'Sudah lama sejak pembersihan terakhir' },
  'Hora de cuidar do Mac': { en: 'Time to take care of your Mac', id: 'Saatnya merawat Mac Anda' },
  'A última Faxina foi há {d} dias.': {
    en: 'The last Sweep was {d} days ago.',
    id: 'Sapu Bersih terakhir dilakukan {d} hari lalu.',
  },
  'Mac ligado há muito tempo': { en: 'Mac has been on for a long time', id: 'Mac sudah menyala sangat lama' },
  'O Mac está ligado há {d} dias. Reiniciar libera memória e aplica atualizações.': {
    en: 'Your Mac has been on for {d} days. Restarting frees up memory and applies updates.',
    id: 'Mac Anda sudah menyala selama {d} hari. Memulai ulang akan membebaskan memori dan menerapkan pembaruan.',
  },
  'Ver Velocidade': { en: 'Open Speed', id: 'Buka Kecepatan' },
  'Memória sob pressão': { en: 'Memory under pressure', id: 'Memori tertekan' },
  'O macOS está comprimindo memória. Feche apps que você não usa.': {
    en: 'macOS is compressing memory. Close apps you aren’t using.',
    id: 'macOS sedang mengompresi memori. Tutup aplikasi yang tidak Anda gunakan.',
  },
  'Memória quase esgotada': { en: 'Memory almost exhausted', id: 'Memori hampir habis' },
  'O Mac está sem memória livre e vai ficar lento. Feche apps agora.': {
    en: 'Your Mac is out of free memory and will slow down. Close apps now.',
    id: 'Mac Anda kehabisan memori kosong dan akan melambat. Tutup aplikasi sekarang.',
  },
  'Acesso Total ao Disco desligado': { en: 'Full Disk Access is off', id: 'Akses Disk Penuh nonaktif' },
  'Sem ele o Limpae não lê a Lixeira nem parte da Biblioteca, e a análise fica incompleta.': {
    en: 'Without it, Limpae can’t read the Trash or part of the Library, and the scan is incomplete.',
    id: 'Tanpa akses ini, Limpae tidak dapat membaca Tempat Sampah maupun sebagian Library, sehingga pemindaian tidak lengkap.',
  },
  'Abrir Ajustes': { en: 'Open Settings', id: 'Buka Pengaturan' },
  'Gatekeeper desligado': { en: 'Gatekeeper is off', id: 'Gatekeeper nonaktif' },
  'O Mac aceita apps de qualquer origem sem verificar. Reative em Ajustes do Sistema › Privacidade e Segurança.': {
    en: 'Your Mac accepts apps from any source without checking. Turn it back on in System Settings › Privacy & Security.',
    id: 'Mac Anda menerima aplikasi dari sumber mana pun tanpa pemeriksaan. Aktifkan kembali di Pengaturan Sistem › Privasi & Keamanan.',
  },
  'Proteção de Integridade do Sistema desligada': { en: 'System Integrity Protection is off', id: 'Perlindungan Integritas Sistem nonaktif' },
  'O SIP protege arquivos do macOS contra alterações. Reative pelo modo de recuperação (csrutil enable).': {
    en: 'SIP protects macOS files from changes. Turn it back on from Recovery mode (csrutil enable).',
    id: 'SIP melindungi file macOS dari perubahan. Aktifkan kembali melalui mode Pemulihan (csrutil enable).',
  },
  'FileVault desligado': { en: 'FileVault is off', id: 'FileVault nonaktif' },
  'Os dados do disco não estão criptografados. Ative em Ajustes do Sistema › Privacidade e Segurança.': {
    en: 'The data on your disk isn’t encrypted. Turn it on in System Settings › Privacy & Security.',
    id: 'Data di disk Anda tidak dienkripsi. Aktifkan di Pengaturan Sistem › Privasi & Keamanan.',
  },
  'Mac virtual': { en: 'Virtual Mac', id: 'Mac virtual' },

  // ---- security/posture.rs
  'Proteção de Integridade do Sistema (SIP)': { en: 'System Integrity Protection (SIP)', id: 'Perlindungan Integritas Sistem (SIP)' },
  'Criptografia do disco (FileVault)': { en: 'Disk encryption (FileVault)', id: 'Enkripsi disk (FileVault)' },
  'Proteção integrada do macOS (XProtect)': { en: 'Built-in macOS protection (XProtect)', id: 'Perlindungan bawaan macOS (XProtect)' },
  'Atualizações automáticas de segurança': { en: 'Automatic security updates', id: 'Pembaruan keamanan otomatis' },
  'O Gatekeeper está ativo e confere os apps antes de abri-los.': {
    en: 'Gatekeeper is on and checks apps before they open.',
    id: 'Gatekeeper aktif dan memeriksa aplikasi sebelum dibuka.',
  },
  'O Gatekeeper está desativado: apps não verificados abrem sem nenhum aviso.': {
    en: 'Gatekeeper is off: unverified apps open without any warning.',
    id: 'Gatekeeper nonaktif: aplikasi yang belum diverifikasi terbuka tanpa peringatan apa pun.',
  },
  'Não foi possível consultar o Gatekeeper.': { en: 'Couldn’t check Gatekeeper.', id: 'Tidak dapat memeriksa Gatekeeper.' },
  'Não foi possível consultar o SIP.': { en: 'Couldn’t check SIP.', id: 'Tidak dapat memeriksa SIP.' },
  'O SIP está ativo e protege os arquivos do sistema.': {
    en: 'SIP is on and protects system files.',
    id: 'SIP aktif dan melindungi file sistem.',
  },
  'O SIP está com configuração personalizada, então parte da proteção está desligada. Só o Modo de Recuperação muda isso.': {
    en: 'SIP has a custom configuration, so part of the protection is off. Only Recovery mode can change that.',
    id: 'SIP memiliki konfigurasi khusus, sehingga sebagian perlindungan nonaktif. Hanya mode Pemulihan yang dapat mengubahnya.',
  },
  'O SIP está desativado. Só o Modo de Recuperação (comando csrutil enable) volta a ativá-lo.': {
    en: 'SIP is off. Only Recovery mode (csrutil enable command) can turn it back on.',
    id: 'SIP nonaktif. Hanya mode Pemulihan (perintah csrutil enable) yang dapat mengaktifkannya kembali.',
  },
  'Não foi possível consultar o FileVault.': { en: 'Couldn’t check FileVault.', id: 'Tidak dapat memeriksa FileVault.' },
  'A criptografia do disco está em andamento.': { en: 'Disk encryption is in progress.', id: 'Enkripsi disk sedang berlangsung.' },
  'O disco está criptografado com o FileVault.': { en: 'The disk is encrypted with FileVault.', id: 'Disk dienkripsi dengan FileVault.' },
  'O disco não está criptografado: quem tiver o Mac em mãos pode ler os arquivos.': {
    en: 'The disk isn’t encrypted: anyone who gets hold of your Mac can read its files.',
    id: 'Disk tidak dienkripsi: siapa pun yang memegang Mac Anda dapat membaca file-nya.',
  },
  'Não foi possível consultar o firewall.': { en: 'Couldn’t check the firewall.', id: 'Tidak dapat memeriksa firewall.' },
  'O firewall está ligado e bloqueia todas as conexões de entrada.': {
    en: 'The firewall is on and blocks all incoming connections.',
    id: 'Firewall aktif dan memblokir semua koneksi masuk.',
  },
  'O firewall está ligado.': { en: 'The firewall is on.', id: 'Firewall aktif.' },
  'O firewall está desligado: apps podem aceitar conexões de entrada sem filtro.': {
    en: 'The firewall is off: apps can accept incoming connections without filtering.',
    id: 'Firewall nonaktif: aplikasi dapat menerima koneksi masuk tanpa penyaringan.',
  },
  'Não foi possível ler a versão das definições do XProtect.': {
    en: 'Couldn’t read the XProtect definitions version.',
    id: 'Tidak dapat membaca versi definisi XProtect.',
  },
  'Definições na versão {version}.': { en: 'Definitions version {version}.', id: 'Definisi versi {version}.' },
  'Definições na versão {version}, atualizadas em {date} ({ago}).': {
    en: 'Definitions version {version}, updated on {date} ({ago}).',
    id: 'Definisi versi {version}, diperbarui pada {date} ({ago}).',
  },
  '{when} Estão desatualizadas: verifique as atualizações de segurança.': {
    en: '{when} They are out of date: check for security updates.',
    id: '{when} Definisi sudah usang: periksa pembaruan keamanan.',
  },
  'hoje': { en: 'today', id: 'hari ini' },
  'há 1 dia': { en: '1 day ago', id: '1 hari lalu' },
  'há {n} dias': { en: '{n} days ago', id: '{n} hari lalu' },
  'Não foi possível ler as preferências de atualização.': {
    en: 'Couldn’t read the update preferences.',
    id: 'Tidak dapat membaca preferensi pembaruan.',
  },
  'arquivos de segurança e respostas rápidas': { en: 'security files and rapid responses', id: 'file keamanan dan respons cepat' },
  'dados de configuração do sistema': { en: 'system configuration data', id: 'data konfigurasi sistem' },
  'arquivos de segurança e respostas rápidas e dados de configuração do sistema': {
    en: 'security files and rapid responses and system configuration data',
    id: 'file keamanan dan respons cepat serta data konfigurasi sistem',
  },
  'As atualizações do macOS também são instaladas sozinhas.': {
    en: 'macOS updates are also installed automatically.',
    id: 'Pembaruan macOS juga dipasang secara otomatis.',
  },
  'As atualizações do macOS ficam para você instalar.': {
    en: 'macOS updates are left for you to install.',
    id: 'Pembaruan macOS dibiarkan untuk Anda pasang sendiri.',
  },
  'Respostas rápidas de segurança e dados do sistema são instalados sozinhos. {tail}': {
    en: 'Rapid security responses and system data are installed automatically. {tail}',
    id: 'Respons keamanan cepat dan data sistem dipasang secara otomatis. {tail}',
  },
  'Instalação automática desligada para: {items}.': {
    en: 'Automatic installation is off for: {items}.',
    id: 'Pemasangan otomatis nonaktif untuk: {items}.',
  },

  // ---- security/privacy.rs
  'Histórico': { en: 'History', id: 'Riwayat' },
  'Sites visitados.': { en: 'Websites visited.', id: 'Situs yang dikunjungi.' },
  'Cookies': { en: 'Cookies', id: 'Cookie' },
  'Você será desconectado dos sites onde está logado.': {
    en: 'You’ll be signed out of the sites where you’re logged in.',
    id: 'Anda akan keluar dari situs tempat Anda masuk.',
  },
  'Formulários': { en: 'Forms', id: 'Formulir' },
  'Dados de preenchimento automático.': { en: 'AutoFill data.', id: 'Data isi otomatis.' },
  'Downloads': { en: 'Downloads', id: 'Unduhan' },
  'Registro e metadados de downloads.': { en: 'Download records and metadata.', id: 'Catatan dan metadata unduhan.' },
  'Sessões': { en: 'Sessions', id: 'Sesi' },
  'Abas e janelas guardadas para restaurar.': { en: 'Tabs and windows saved for restoring.', id: 'Tab dan jendela yang disimpan untuk dipulihkan.' },
  'Inclui os favoritos': { en: 'Includes bookmarks', id: 'Termasuk bookmark' },
  'Inclui cartões e endereços salvos': { en: 'Includes saved cards and addresses', id: 'Termasuk kartu dan alamat tersimpan' },
  'Itens recentes': { en: 'Recent items', id: 'Item terbaru' },
  'Listas de documentos, apps e servidores abertos recentemente.': {
    en: 'Lists of recently opened documents, apps and servers.',
    id: 'Daftar dokumen, aplikasi, dan server yang baru dibuka.',
  },
  'Feche o {browser} para limpar.': { en: 'Quit {browser} to clean.', id: 'Tutup {browser} untuk membersihkan.' },

  // ---- security/tcc.rs
  'Câmera': { en: 'Camera', id: 'Kamera' },
  'Microfone': { en: 'Microphone', id: 'Mikrofon' },
  'Gravação de tela': { en: 'Screen Recording', id: 'Perekaman Layar' },
  'Acessibilidade': { en: 'Accessibility', id: 'Aksesibilitas' },
  'Monitoramento de entrada': { en: 'Input Monitoring', id: 'Pemantauan Input' },
  'Acesso Total ao Disco': { en: 'Full Disk Access', id: 'Akses Disk Penuh' },
  'Contatos': { en: 'Contacts', id: 'Kontak' },
  'Calendários': { en: 'Calendars', id: 'Kalender' },
  'Lembretes': { en: 'Reminders', id: 'Pengingat' },
  'Fotos': { en: 'Photos', id: 'Foto' },
  'Localização': { en: 'Location', id: 'Lokasi' },
  'caminho inválido': { en: 'invalid path', id: 'path tidak valid' },
  'o sqlite3 não respondeu a tempo': { en: 'sqlite3 didn’t respond in time', id: 'sqlite3 tidak merespons tepat waktu' },
  'Serviço de permissão desconhecido.': { en: 'Unknown permission service.', id: 'Layanan izin tidak dikenal.' },
  'Identificador de app inválido.': { en: 'Invalid app identifier.', id: 'Pengenal aplikasi tidak valid.' },
  'O tccutil não respondeu a tempo.': { en: 'tccutil didn’t respond in time.', id: 'tccutil tidak merespons tepat waktu.' },
  'O macOS recusou a revogação.': { en: 'macOS refused to revoke the permission.', id: 'macOS menolak pencabutan izin.' },
  'O macOS recusou a revogação: {why}.': { en: 'macOS refused to revoke the permission: {why}.', id: 'macOS menolak pencabutan izin: {why}.' },

  // ---- perf.rs
  'Do sistema · requer administrador': { en: 'System item · requires administrator', id: 'Item sistem · memerlukan administrator' },
  'Item da Apple': { en: 'Apple item', id: 'Item Apple' },
  'Pertence ao Limpae': { en: 'Belongs to Limpae', id: 'Milik Limpae' },
  'Arquivo vazio, sem rótulo ou ilegível': { en: 'File is empty, has no label or is unreadable', id: 'File kosong, tanpa label, atau tidak dapat dibaca' },
  'o arquivo não está na pasta de agentes do usuário': {
    en: 'the file isn’t in the user agents folder',
    id: 'file tidak berada di folder agen pengguna',
  },
  'o arquivo do agente não existe mais': { en: 'the agent file no longer exists', id: 'file agen sudah tidak ada' },
  'o agente não é um arquivo comum': { en: 'the agent isn’t a regular file', id: 'agen bukan file biasa' },
  'o rótulo do agente é inválido ou ilegível': { en: 'the agent label is invalid or unreadable', id: 'label agen tidak valid atau tidak dapat dibaca' },
  'rótulo de agente inválido': { en: 'invalid agent label', id: 'label agen tidak valid' },
  'O launchd recusou a alteração.': { en: 'launchd refused the change.', id: 'launchd menolak perubahan tersebut.' },
  'O agente foi desativado, mas não pôde ser parado agora. Ele deixa de abrir no próximo login.': {
    en: 'The agent was disabled but couldn’t be stopped right now. It will stop opening at the next login.',
    id: 'Agen dinonaktifkan, tetapi tidak dapat dihentikan sekarang. Agen tidak akan terbuka lagi saat login berikutnya.',
  },
  'não foi possível executar o osascript: {e}': { en: 'couldn’t run osascript: {e}', id: 'tidak dapat menjalankan osascript: {e}' },
  'Não foi possível executar o osascript: {e}': { en: 'Couldn’t run osascript: {e}', id: 'Tidak dapat menjalankan osascript: {e}' },
  'o System Events não respondeu a tempo': { en: 'System Events didn’t respond in time', id: 'System Events tidak merespons tepat waktu' },
  'Falta a permissão de Automação para o System Events.': {
    en: 'Automation permission for System Events is missing.',
    id: 'Izin Otomasi untuk System Events belum diberikan.',
  },
  'Não foi possível reler os itens de login: {m}': { en: 'Couldn’t reread the login items: {m}', id: 'Tidak dapat membaca ulang item login: {m}' },
  'O item de login não existe mais.': { en: 'The login item no longer exists.', id: 'Item login sudah tidak ada.' },
  'O item de login mudou desde a análise. Analise de novo.': {
    en: 'The login item changed since the scan. Scan again.',
    id: 'Item login berubah sejak pemindaian. Pindai lagi.',
  },
  'Há mais de um item de login com este nome. Remova-o em Ajustes do Sistema.': {
    en: 'More than one login item has this name. Remove it in System Settings.',
    id: 'Ada lebih dari satu item login dengan nama ini. Hapus di Pengaturan Sistem.',
  },
  'O System Events não conseguiu remover o item.': { en: 'System Events couldn’t remove the item.', id: 'System Events tidak dapat menghapus item tersebut.' },
  'Não foi possível listar os snapshots locais.': { en: 'Couldn’t list the local snapshots.', id: 'Tidak dapat menampilkan daftar snapshot lokal.' },
  'O tmutil não conseguiu afinar os snapshots locais.': { en: 'tmutil couldn’t thin the local snapshots.', id: 'tmutil tidak dapat mengurangi snapshot lokal.' },
};
