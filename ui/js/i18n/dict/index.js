// Dicionário: chave = texto em português da interface (ou devolvido pelo backend) → { en, id }. Um arquivo por dono;
// chaves repetidas devem ter as mesmas traduções (scripts/check-i18n.mjs confere).
import shell from './shell.js';
import smart from './smart.js';
import clean from './clean.js';
import apps from './apps.js';
import files from './files.js';
import lens from './lens.js';
import protection from './protection.js';
import performance from './performance.js';
import backendCore from './backend-core.js';
import backendCoreB from './backend-core-b.js';
import backendCoreC from './backend-core-c.js';
import backendApp from './backend-app.js';

export const DICT = { ...shell, ...smart, ...clean, ...apps, ...files, ...lens, ...protection, ...performance, ...backendCore, ...backendCoreB, ...backendCoreC, ...backendApp };
