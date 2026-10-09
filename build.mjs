// Inlines pdf-lib and the bleed engine into one self-contained AddBleed.html
// that works offline by double-clicking it.
import { readFileSync, writeFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const html = read('./src/index.html')
  .replace('/*PDFLIB*/', () => safe(read('./node_modules/pdf-lib/dist/pdf-lib.min.js')))
  .replace('/*BLEED*/', () => safe(read('./src/bleed.js')));

writeFileSync(new URL('./AddBleed.html', import.meta.url), html);
console.log(`AddBleed.html written (${(html.length / 1024).toFixed(0)} KB)`);
