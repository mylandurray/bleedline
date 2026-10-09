// Inlines pdf-lib and the bleed engine into one self-contained AddBleed.html
// that works offline by double-clicking it.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

// Build stamp: short commit hash ("-dirty" if anything other than the generated AddBleed.html differs) and the date.
function stamp() {
  const cwd = new URL('.', import.meta.url);
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const date = new Date().toISOString().slice(0, 10);
  try {
    const hash = git('rev-parse', '--short', 'HEAD').trim();
    const dirty = git('status', '--porcelain').split(/\r?\n/).filter(Boolean).some((l) => l.slice(3).trim() !== 'AddBleed.html');
    return `${hash}${dirty ? '-dirty' : ''}, ${date}`;
  } catch (e) {
    return `unknown, ${date}`;
  }
}

const html = read('./src/index.html')
  .replace('/*PDFLIB*/', () => safe(read('./node_modules/pdf-lib/dist/pdf-lib.min.js')))
  .replace('/*BUILD*/', () => stamp())
  .replace('/*BLEED*/', () => safe(read('./src/bleed.js')));

writeFileSync(new URL('./AddBleed.html', import.meta.url), html);
console.log(`AddBleed.html written (${(html.length / 1024).toFixed(0)} KB)`);
