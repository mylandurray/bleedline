// Inlines pdf-lib and the bleed engine into one self-contained Bleedline.html
// that works offline by double-clicking it.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

// Build stamp: short commit hash ("-dirty" if anything other than the generated Bleedline.html differs) and the date.
function stamp() {
  const cwd = new URL('.', import.meta.url);
  const git = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const date = new Date().toISOString().slice(0, 10);
  try {
    const hash = git('rev-parse', '--short', 'HEAD').trim();
    const dirty = git('status', '--porcelain').split(/\r?\n/).filter(Boolean).some((l) => l.slice(3).trim() !== 'Bleedline.html');
    return `${hash}${dirty ? '-dirty' : ''}, ${date}`;
  } catch (e) {
    return `unknown, ${date}`;
  }
}

// PDF.js for the preview: its module and worker go in as text (loaded from blob URLs at run time),
// and the JPEG 2000 / JBIG2 decoders as base64, so the preview works offline too.
const pdfjs = (f) => new URL(`./node_modules/pdfjs-dist/${f}`, import.meta.url);
const wasm = Object.fromEntries(['openjpeg.wasm', 'jbig2.wasm'].map((f) => [f, readFileSync(pdfjs(`wasm/${f}`)).toString('base64')]));

const html = read('./src/index.html')
  .replace('/*PDFJS*/', () => safe(readFileSync(pdfjs('build/pdf.min.mjs'), 'utf8')))
  .replace('/*PDFJS_WORKER*/', () => safe(readFileSync(pdfjs('build/pdf.worker.min.mjs'), 'utf8')))
  .replace('/*PDFJS_WASM*/', () => JSON.stringify(wasm))
  .replace('/*PDFLIB*/', () => safe(read('./node_modules/pdf-lib/dist/pdf-lib.min.js')))
  .replace('/*BUILD*/', () => stamp())
  .replace('/*BLEED*/', () => safe(read('./src/bleed.js')));

writeFileSync(new URL('./Bleedline.html', import.meta.url), html);
console.log(`Bleedline.html written (${(html.length / 1024).toFixed(0)} KB)`);
