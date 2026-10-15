// Pixel check: renders each PDF in test/samples/ before and after addBleed (seam-hiding off) with
// Ghostscript, trim area only, and counts pixels that differ. Run with `npm run check-samples`.
// Not part of `npm test` (needs Ghostscript and local sample files).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const TOLERANCE = 2; // per channel, out of 255

export function findGhostscript() {
  const names = process.platform === 'win32' ? ['gswin64c', 'gswin32c'] : ['gs'];
  for (const n of names) {
    const r = spawnSync(n, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return n;
  }
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles || 'C:\\Program Files', 'C:\\Program Files (x86)']) {
      const gsDir = join(root, 'gs');
      if (!existsSync(gsDir)) continue;
      const vers = readdirSync(gsDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of vers) for (const exe of ['gswin64c.exe', 'gswin32c.exe']) {
        const p = join(gsDir, v, 'bin', exe);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

// PAM: a text header ("P7", WIDTH, HEIGHT, DEPTH, MAXVAL, TUPLTYPE, ENDHDR) then raw samples.
export function parsePam(buf) {
  let pos = 0;
  const line = () => {
    const end = buf.indexOf(10, pos);
    if (end < 0) throw new Error('Bad PAM header');
    const s = buf.toString('latin1', pos, end).trim();
    pos = end + 1;
    return s;
  };
  if (line() !== 'P7') throw new Error('Not a PAM file');
  const h = {};
  for (;;) {
    const l = line();
    if (l === 'ENDHDR') break;
    if (!l || l.startsWith('#')) continue;
    const [k, ...v] = l.split(/\s+/);
    h[k] = v.join(' ');
  }
  const width = +h.WIDTH, height = +h.HEIGHT, depth = +h.DEPTH, maxval = +h.MAXVAL;
  if (!(width > 0 && height > 0 && depth > 0 && maxval === 255)) throw new Error('Unsupported PAM header');
  const data = buf.subarray(pos, pos + width * height * depth);
  if (data.length !== width * height * depth) throw new Error('PAM data is truncated');
  return { width, height, depth, data };
}

// Max per-channel difference, and the number of pixels where any channel differs by more than tol.
export function comparePam(a, b, tol = TOLERANCE) {
  if (a.width !== b.width || a.height !== b.height || a.depth !== b.depth)
    return { sizeMismatch: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
  let maxDiff = 0, diffPixels = 0;
  const d = a.depth;
  for (let i = 0; i < a.width * a.height; i++) {
    let bad = false;
    for (let c = 0; c < d; c++) {
      const v = Math.abs(a.data[i * d + c] - b.data[i * d + c]);
      if (v > maxDiff) maxDiff = v;
      if (v > tol) bad = true;
    }
    if (bad) diffPixels++;
  }
  return { maxDiff, diffPixels };
}

function render(gs, pdfPath, outPath) {
  execFileSync(gs, ['-dBATCH', '-dNOPAUSE', '-dSAFER', '-q', '-dUseTrimBox', '-sDEVICE=pamcmyk32', '-r300',
    `-sOutputFile=${outPath}`, pdfPath], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  const gs = findGhostscript();
  if (!gs) {
    console.log([
      'Ghostscript was not found, so the pixel check cannot run.',
      'Install it, then run `npm run check-samples` again:',
      '  winget install ArtifexSoftware.GhostScript',
      '  (or download the 64-bit installer from https://ghostscript.com/releases/gsdnld.html)',
      'It should end up at C:\\Program Files\\gs\\gs<version>\\bin\\gswin64c.exe, or on PATH as gswin64c.',
    ].join('\n'));
    return;
  }
  const dir = join(here, 'samples');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).sort() : [];
  if (!files.length) {
    console.log(`No sample PDFs found: ${existsSync(dir) ? 'test/samples/ is empty' : 'test/samples/ does not exist'}.\n` +
      'Put PDFs in test/samples/ (it is not in git) and run `npm run check-samples` again.');
    return;
  }
  const PDFLib = require('pdf-lib');
  const { addBleed } = require('../src/bleed.js');
  const opts = { bleedMm: 3, mode: 'mirror', sliverMm: 0.5, marks: true, markOffsetMm: 3, markLenMm: 5,
    markWeightPt: 0.25, imageDpi: 300, useFileDpi: true, hideSeams: false, keepBleed: false };
  const tmp = mkdtempSync(join(tmpdir(), 'bleedline-'));
  const rows = [];
  try {
    for (const f of files) {
      const row = { file: f, trim: '-', maxDiff: '-', diffPixels: '-', warnings: '' };
      rows.push(row);
      try {
        const srcBytes = readFileSync(join(dir, f));
        const r = await addBleed(PDFLib, srcBytes, 'pdf', opts);
        row.warnings = r.warnings.length;
        row.trim = r.pages.map((p) => `${p.wMm.toFixed(1)}x${p.hMm.toFixed(1)}`).join(' ');
        // Reference: the source with its TrimBox set to the trim the tool used (boxes only).
        const ref = await PDFLib.PDFDocument.load(srcBytes, { ignoreEncryption: true, updateMetadata: false });
        ref.getPages().forEach((p, i) => {
          const t = r.pages[i].srcTrim;
          p.setTrimBox(t[0], t[1], t[2] - t[0], t[3] - t[1]);
        });
        const refPath = join(tmp, 'ref.pdf'), outPdf = join(tmp, 'out.pdf');
        writeFileSync(refPath, await ref.save());
        writeFileSync(outPdf, r.bytes);
        render(gs, refPath, join(tmp, 'ref%03d.pam'));
        render(gs, outPdf, join(tmp, 'out%03d.pam'));
        let maxDiff = 0, diffPixels = 0, sizeBad = false;
        for (let i = 0; i < r.pages.length; i++) {
          const n = String(i + 1).padStart(3, '0');
          const c = comparePam(parsePam(readFileSync(join(tmp, `ref${n}.pam`))), parsePam(readFileSync(join(tmp, `out${n}.pam`))));
          if (c.sizeMismatch) { sizeBad = true; row.warnings += ` p${i + 1} size ${c.sizeMismatch}`; continue; }
          maxDiff = Math.max(maxDiff, c.maxDiff);
          diffPixels += c.diffPixels;
        }
        row.maxDiff = maxDiff;
        row.diffPixels = sizeBad ? 'SIZE' : diffPixels;
        row.bad = sizeBad || diffPixels > 0;
      } catch (e) {
        row.maxDiff = 'ERROR';
        row.warnings = String(e.message || e).split('\n')[0].slice(0, 80);
        row.bad = true;
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const cols = [['file', 'File'], ['trim', 'Trim (mm)'], ['maxDiff', 'Max diff'], ['diffPixels', 'Pixels > 2/255'], ['warnings', 'Warnings']];
  const w = cols.map(([k, t]) => Math.max(t.length, ...rows.map((r) => String(r[k]).length)));
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  console.log(fmt(cols.map((c) => c[1])));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(fmt(cols.map(([k]) => r[k])));
  const bad = rows.filter((r) => r.bad).length;
  console.log(`\n${rows.length} file(s), ${bad} with differences or errors.`);
  if (bad) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
