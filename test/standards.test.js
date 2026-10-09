// PDF/X and PDF/A rules, trailer /ID and XMP instance (phase 4b).
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const PDFLib = require('pdf-lib');
const { PDFName, PDFString, PDFDict, PDFArray, PDFRawStream } = PDFLib;
const { addBleed } = require('../src/bleed.js');
const fx = require('./fixtures.js');
const { checkOutput } = require('./invariants.js');

const MM = fx.MM;
const N = (s) => PDFName.of(s);
const base = {
  bleedMm: 3, mode: 'mirror', sliverMm: 0.5, marks: true, markOffsetMm: 3, markLenMm: 5,
  markWeightPt: 0.25, imageDpi: 300, useFileDpi: true, hideSeams: false,
};
const run = (bytes, kind, o = {}) => addBleed(PDFLib, bytes, kind, { ...base, ...o });
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

const xmpPacket = ({ pdfx, pdfaPart, instance = 'uuid:11111111-2222-3333-4444-555555555555' }) => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <xmp:CreateDate>2020-01-01T10:00:00+00:00</xmp:CreateDate>
   <xmp:ModifyDate>2020-01-01T10:00:00+00:00</xmp:ModifyDate>
   <xmp:MetadataDate>2020-01-01T10:00:00+00:00</xmp:MetadataDate>
   <xmpMM:DocumentID>uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</xmpMM:DocumentID>
   <xmpMM:InstanceID>${instance}</xmpMM:InstanceID>
   ${pdfx ? `<pdfxid:GTS_PDFXVersion>${pdfx}</pdfxid:GTS_PDFXVersion>` : ''}
   ${pdfaPart ? `<pdfaid:part>${pdfaPart}</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>` : ''}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/** A page that claims a standard: Info + (flate-compressed) XMP, with the given header version. */
async function claimed({ pdfx, pdfaPart, version = '1.3', xmp = true, id = true } = {}) {
  const bytes = await fx.page({ media: [100 * MM, 70 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 70), [0, 0.5, 1, 0]) }, {
    setup: (doc) => {
      const ctx = doc.context;
      const info = ctx.obj({ Title: PDFString.of('Test'), ModDate: PDFString.of("D:20200101100000+00'00'") });
      if (pdfx) { info.set(N('GTS_PDFXVersion'), PDFString.of(pdfx)); info.set(N('GTS_PDFXConformance'), PDFString.of(pdfx)); }
      ctx.trailerInfo.Info = ctx.register(info);
      if (xmp) {
        const s = ctx.stream(zlib.deflateSync(Buffer.from(xmpPacket({ pdfx, pdfaPart }), 'utf8')),
          { Type: 'Metadata', Subtype: 'XML', Filter: 'FlateDecode' });
        doc.catalog.set(N('Metadata'), ctx.register(s));
      }
      if (id) ctx.trailerInfo.ID = ctx.obj([PDFLib.PDFHexString.of('00112233445566778899aabbccddeeff'), PDFLib.PDFHexString.of('00112233445566778899aabbccddeeff')]);
    },
  });
  bytes[5] = version.charCodeAt(0); bytes[7] = version.charCodeAt(2); // pdf-lib always writes 1.7
  return bytes;
}

async function load(bytes) { return PDFLib.PDFDocument.load(bytes, { updateMetadata: false }); }

function hasGroup(doc) {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const d = obj instanceof PDFRawStream ? obj.dict : obj;
    const g = d instanceof PDFDict ? d.lookup(N('Group')) : null;
    if (g instanceof PDFDict && g.get(N('S')) === N('Transparency')) return true;
  }
  return false;
}

function idOf(doc) {
  const id = doc.context.lookup(doc.context.trailerInfo.ID);
  assert.ok(id instanceof PDFArray && id.size() === 2, 'trailer /ID with two entries');
  return id.asArray().map((x) => Buffer.from(x.asBytes()).toString('hex'));
}

function xmpText(doc) {
  const s = doc.catalog.lookup(N('Metadata'));
  assert.ok(s instanceof PDFRawStream, 'Metadata stream');
  assert.equal(s.dict.get(N('Filter')), undefined, 'metadata must be unfiltered');
  return Buffer.from(s.getContents()).toString('utf8');
}

test('PDF/X-1a source: 1.3 header, classic xref, /ID, no groups, new InstanceID', async () => {
  const src = await claimed({ pdfx: 'PDF/X-1a:2001' });
  const r = await run(src, 'pdf', { hideSeams: true });
  await checkOutput(r.bytes, { trimMm: [100, 70], bleedMm: 3, marks: true, source: src, rawContent: true });
  const text = latin1(r.bytes);
  assert.ok(text.startsWith('%PDF-1.3\n'), text.slice(0, 9));
  assert.ok(!text.includes('/ObjStm'), 'no object streams');
  assert.ok(!text.includes('/XRef'), 'no xref stream');
  assert.ok(/\nxref\n0 \d+\n/.test(text) && /\ntrailer\n<</.test(text), 'classic xref table and trailer');
  assert.ok(/\/ID \[/.test(text), '/ID written in the trailer');
  assert.ok(r.warnings.some((w) => w === 'Seam hiding skipped to keep the file PDF/X-1a valid.'), r.warnings.join('|'));
  assert.ok(r.warnings.some((w) => /^Source is PDF\/X-1a: claim kept; re-verify in Acrobat Preflight/.test(w)), r.warnings.join('|'));

  const out = await load(r.bytes);
  assert.equal(hasGroup(out), false);
  const [id0, id1] = idOf(out);
  assert.equal(id0, '00112233445566778899aabbccddeeff', 'first ID kept from the source');
  assert.notEqual(id1, '00112233445566778899aabbccddeeff', 'second ID is new');

  const xmp = xmpText(out);
  const inst = /<xmpMM:InstanceID>([^<]*)</.exec(xmp)[1];
  assert.match(inst, /^uuid:[0-9a-f-]{36}$/);
  assert.notEqual(inst, 'uuid:11111111-2222-3333-4444-555555555555');
  assert.match(xmp, /<pdfxid:GTS_PDFXVersion>PDF\/X-1a:2001</, 'claim kept');
  const modify = /<xmp:ModifyDate>([^<]*)</.exec(xmp)[1];
  assert.equal(/<xmp:MetadataDate>([^<]*)</.exec(xmp)[1], modify);
  assert.notEqual(modify, '2020-01-01T10:00:00+00:00');
  const info = out.context.lookup(out.context.trailerInfo.Info);
  const mod = info.lookup(N('ModDate')).decodeText();
  assert.equal(mod, `D:${modify.slice(0, 19).replace(/[-T:]/g, '')}+00'00'`, 'Info /ModDate matches xmp:ModifyDate');
  assert.equal(info.lookup(N('GTS_PDFXVersion')).decodeText(), 'PDF/X-1a:2001');
});

test('PDF/A-1 claim from XMP only: no groups, no object streams', async () => {
  const src = await claimed({ pdfaPart: 1, version: '1.4' });
  const r = await run(src, 'pdf', { hideSeams: true, marks: false });
  const text = latin1(r.bytes);
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(!text.includes('/ObjStm'));
  assert.equal(hasGroup(await load(r.bytes)), false);
  assert.ok(r.warnings.includes('Seam hiding skipped to keep the file PDF/A-1 valid.'), r.warnings.join('|'));
});

test('PDF/X-4 source: groups allowed, header kept, claim warning', async () => {
  const src = await claimed({ pdfx: 'PDF/X-4', version: '1.6' });
  const r = await run(src, 'pdf', { hideSeams: true, marks: false });
  assert.ok(latin1(r.bytes).startsWith('%PDF-1.6\n'));
  assert.equal(hasGroup(await load(r.bytes)), true);
  assert.ok(!r.warnings.some((w) => /Seam hiding skipped/.test(w)));
  assert.ok(r.warnings.includes('Source is PDF/X-4: claim kept; re-verify in Acrobat Preflight before sending.'), r.warnings.join('|'));
});

test('plain 1.7 file with hideSeams still gets groups and object streams', async () => {
  const src = await claimed({ xmp: false, id: false, version: '1.7' });
  const r = await run(src, 'pdf', { hideSeams: true, marks: false });
  const text = latin1(r.bytes);
  assert.ok(text.startsWith('%PDF-1.7\n'));
  assert.ok(text.includes('/ObjStm'));
  const out = await load(r.bytes);
  assert.equal(hasGroup(out), true);
  idOf(out);
  assert.ok(!r.warnings.some((w) => /claim kept|Seam hiding skipped/.test(w)), r.warnings.join('|'));
});

test('plain 1.3 file with hideSeams is raised to 1.4; without groups it stays 1.3', async () => {
  const src = await claimed({ xmp: false, version: '1.3' });
  const on = await run(src, 'pdf', { hideSeams: true, marks: false });
  assert.ok(latin1(on.bytes).startsWith('%PDF-1.4\n'));
  assert.ok(!latin1(on.bytes).includes('/ObjStm'), 'below 1.5: no object streams');
  const off = await run(src, 'pdf', { hideSeams: false, marks: false });
  assert.ok(latin1(off.bytes).startsWith('%PDF-1.3\n'));
});

test('catalog /Version above the header wins', async () => {
  const bytes = await fx.page({ media: [100 * MM, 70 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 70), [0, 0, 0, 1]) }, {
    setup: (doc) => doc.catalog.set(N('Version'), N('1.6')),
  });
  bytes[7] = '4'.charCodeAt(0);
  const r = await run(bytes, 'pdf', { marks: false });
  assert.ok(latin1(r.bytes).startsWith('%PDF-1.6\n'));
});

test('XMP that cannot be edited cleanly: XMP and Info both left alone', async () => {
  const bytes = await fx.page({ media: [100 * MM, 70 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 70), [0, 0, 0, 1]) }, {
    setup: (doc) => {
      const ctx = doc.context;
      ctx.trailerInfo.Info = ctx.register(ctx.obj({ ModDate: PDFString.of("D:20200101100000+00'00'") }));
      // Two InstanceIDs: ambiguous, so nothing may change.
      const x = xmpPacket({}).replace('</rdf:Description>', '<xmpMM:InstanceID>uuid:x</xmpMM:InstanceID></rdf:Description>');
      doc.catalog.set(N('Metadata'), ctx.register(ctx.stream(Buffer.from(x, 'utf8'), { Type: 'Metadata', Subtype: 'XML' })));
    },
  });
  const r = await run(bytes, 'pdf', { marks: false });
  const out = await load(r.bytes);
  const xmp = xmpText(out);
  assert.match(xmp, /<xmp:ModifyDate>2020-01-01T10:00:00\+00:00</);
  assert.match(xmp, /<xmpMM:InstanceID>uuid:11111111-2222-3333-4444-555555555555</);
  assert.equal(out.context.lookup(out.context.trailerInfo.Info).lookup(N('ModDate')).decodeText(), "D:20200101100000+00'00'");
});

test('XMP properties written as attributes are edited too', async () => {
  const bytes = await fx.page({ media: [100 * MM, 70 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 70), [0, 0, 0, 1]) }, {
    setup: (doc) => {
      const x = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
        '<rdf:Description rdf:about="" xmp:ModifyDate="2020-01-01T10:00:00Z" xmpMM:InstanceID="uuid:old"/></rdf:RDF></x:xmpmeta>';
      doc.catalog.set(N('Metadata'), doc.context.register(doc.context.stream(Buffer.from(x, 'utf8'), { Type: 'Metadata', Subtype: 'XML' })));
    },
  });
  const r = await run(bytes, 'pdf', { marks: false });
  const xmp = xmpText(await load(r.bytes));
  assert.doesNotMatch(xmp, /uuid:old|2020-01-01/);
  assert.match(xmp, /xmpMM:InstanceID="uuid:[0-9a-f-]{36}"/);
});

test('image input gets a trailer /ID', async () => {
  const r = await run(fx.jpg({ width: 600, height: 300, dpi: 300 }), 'jpg');
  idOf(await load(r.bytes));
  const r2 = await run(fx.png({ width: 60, height: 30 }), 'png', { useFileDpi: false, imageDpi: 150 });
  idOf(await load(r2.bytes));
});
