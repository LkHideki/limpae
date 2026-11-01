// Dictionary: key = Portuguese UI text (or returned by the backend) → { en, id }. One file per owner;
// repeated keys must have the same translations (scripts/check-i18n.mjs checks this).
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
