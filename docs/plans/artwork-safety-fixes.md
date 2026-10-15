status: active

# Artwork safety fixes: implementation plan

This plans the fixes for the findings in [artwork-safety-audit.md](artwork-safety-audit.md). Item numbers (#1–#6)
refer to that audit. The checklist at the end of this doc replaces the audit's checklist.

## Build order

| Phase | What | Why this position | Where |
|---|---|---|---|
| 0 | Test harness (`npm test`) | Every later fix lands with a test | `main` |
| 1 | Input validation, stale downloads, box normalisation | High severity and small. Silent damage today | `main` |
| 2 | Strict crop-mark detection (#1) | The only critical item. The most code, so it needs the harness | `main` |
| 3 | Seam-hiding off by default (#2) | One-line default plus a settings migration | `main` |
| 4 | Single content copy, then PDF/X and PDF/A (#3, #5) | Both change how the output is built and saved. Copy first, then the save rules on top | `main` |
| 5 | Small fixes and wording (#4, #5 notes) | Low risk. Do them once the code has settled, so the wording matches | `main` |
| 6 | Optional: keep existing bleed, per-file Set size | New behaviour, not a fix | branch `bleed-options` |
| 7 | Build stamp, rebuild, real-file run, close out | Rollout | `main` |

Every phase ends with `npm test` passing, `npm run build`, and a commit, so `Bleedline.html` is never stale
against `src/`. Each phase updates the README and in-app help for whatever it changes.

---

## Phase 0: test harness

**Goal:** structural checks in plain Node, with no new dependencies. Pixel comparison comes later (phase 7) and
needs Ghostscript.

1. `package.json`: `"test": "node --test test/"`. Node 24 has `node:test` built in.
2. `test/fixtures.js`: helpers that build small PDFs in memory with pdf-lib, so no binary fixtures are committed.
   - `page({ media, trim, crop, bleed, rotate, content, resources })`: returns the PDF bytes.
   - Content snippets: `cropMarks(trim, { offset, len, width, bleedMarks })`, `table(x, y, cols, rows, cw, ch)`
     (per-cell `m l S` segments, as Word and Excel export them), `dieline(rect)`, `fill(rect, cmyk)`.
3. `test/invariants.js`: `checkOutput(bytes, expect)`. It checks the following for each page:
   - TrimBox ⊆ BleedBox ⊆ MediaBox, and all of them have positive size.
   - The TrimBox size equals `expect.trimMm` (±0.01 mm).
   - The bleed equals `expect.bleedMm` on all four sides.
   - With seam-hiding off, the centre cell's clip is exactly the TrimBox.
   - The `Art` XObject's content equals the source page content (decoded bytes compared). Once phase 4 is done,
     the raw bytes must also be equal for single-stream pages.
   - Trim marks lie entirely outside the BleedBox.
4. `test/basic.test.js`: one happy-path test per input type (PDF with a TrimBox, PDF without one, JPG, PNG),
   so the harness proves itself before the fixes go in.
5. `.gitignore`: add `test/samples/`. Real customer files go there and are never committed.

**Done when:** `npm test` passes on the current code (except tests written for known bugs, which are added in
their phase).

---

## Phase 1: high-severity input and UI fixes

### 1a. Validate numbers (negative bleed cuts the artwork)

`src/bleed.js`: add `validateOpts(opts)` and call it first in `addBleed`. It throws a plain-English `Error` when:
- `bleedMm` is not finite, is < 0, or is > 50;
- the mode is stretch and `sliverMm` ≤ 0;
- marks are on and `markLenMm` ≤ 0, `markWeightPt` ≤ 0, or `markOffsetMm` < 0;
- `imageDpi` ≤ 0 or is not finite (only checked for images);
- exactly one of `trimWMm`/`trimHMm` is set, or either one is ≤ 0.

Add `warn('No bleed added (bleed is 0 mm).')` when the bleed is 0.

`src/index.html`:
- `readOpts()`: drop `|| 0`, so an empty field reads as `NaN` and fails validation instead of becoming 0.
- Add `checkOpts()`, which mirrors the rules above. It adds a `.bad` class (red border) to each invalid field. If
  anything is invalid, it sets each file's meta to "Fix the highlighted setting" and doesn't reprocess.
- *Set size* with an empty W or H highlights those fields instead of quietly running Auto.

**Tests:** negative bleed throws; `NaN` bleed throws; 0 bleed works and warns; stretch with a 0 sliver throws;
half-filled W/H throws.

### 1b. Stale downloads

`src/index.html`:
- `markStale()`: disables every Download button and sets the meta to "Updating…". Call it synchronously from an
  `input` listener and from the existing `change` listener on `.side`, before the 150 ms debounce. Typing then
  clicking Download can no longer save the old output.
- Give each entry a run counter, `entry.run`. `process()` takes `const run = ++entry.run` and, after every `await`,
  returns early if `run !== entry.run`. A stale run never writes `entry.url`, `entry.pages` or the warnings.
- Store `entry.opts = opts` (the options actually used) with each result. `showTrim` reads
  `entry.opts.bleedMm`, not the live field.
- `download()`: refuse if `entry.run` is newer than the run that produced `entry.url` (belt and braces).

**Test:** manual, in the browser pane. Type a new bleed and click Download straight away: the button is disabled.
Change the bleed twice quickly on a large file: the final output has the second value (check the BleedBox in
the preview's header).

### 1c. Normalise boxes

`src/bleed.js`: `rect()` returns
`{x0: min(x, x+w), x1: max(...), y0: min(...), y1: max(...)}`. Throw `"Page N has an empty <box>"` if the width
or height is < 1 pt. Also warn when the TrimBox extends beyond the MediaBox (blank edges).

**Tests:** MediaBox `[300 400 0 0]` gives a positive 105.8 × 141.1 mm trim; a zero-area MediaBox throws; a TrimBox
bigger than the MediaBox warns.

**Commit per sub-item.**

---

## Phase 2: strict crop-mark detection (#1)

### 2a. `collectLines` records more, and fails safe

- If the budget runs out, return `null`. `findCropMarks` then returns `null`, and the warning says "page too
  complex to check for crop marks".
- Track line width: the `w` operator, scaled by `sqrt(|det(ctm)|)`. Each line records `width`.
- Track hidden optional content. Keep a marked-content stack. `BDC /OC /Name` looks up
  `Resources/Properties/Name`. If it's an OCG in `OCProperties/D/OFF`, or an OCMD whose OCGs are all OFF, the
  content until the matching `EMC` is hidden. `BMC` and other `BDC`s push "not hidden". A form XObject with an
  `/OC` entry pointing to an OFF group is skipped. Lines drawn while hidden aren't recorded.
- Form `/BBox`: transform it by the form's matrix and the CTM. Drop lines that lie entirely outside it.
- Keep **all** axis-aligned lines, not only short ones, in a separate `long` list for the edge checks in 2b.

### 2b. `findCropMarks` validation

Candidate generation stays as it is. A candidate (L, R, B, T) is accepted only if **all** of these hold:

1. **Margin marks only.** Each mark used lies wholly outside the trim rectangle, with its near end within 25 mm
   of its corner (`l.b ≤ B + tol && l.b ≥ B − 25 mm` and so on).
2. **No trim edge drawn.** No line (short or long) is collinear with a trim edge and covers more than 2 mm of that
   edge between the corners. This kills table cells and dielines: real crop marks never draw the trim itself.
3. **Nothing crosses in.** No mark-like line starts outside the candidate and ends inside it.
4. **Size and position.** The area is at least 50% of the MediaBox area, and the centre is within 10% of the
   page size of the MediaBox centre.
5. **Mark weight.** Every mark used has `width ≤ 1.5 pt`.

**Choosing between valid candidates:**
- Highest score first (8 means all eight marks).
- Among equal scores: if the candidates are **concentric** (nested, with the same centre ±0.5 mm), they're trim
  plus bleed marks, so take the innermost.
- If they aren't concentric, it's ambiguous: return `null` and warn "Found more than one possible set of crop
  marks; set the trim size by hand".

Return `{ x0, y0, x1, y1, score }`. The warning keeps the found size and adds "(N of 8 marks)" when the score is
below 8.

### 2c. Tests

Generated fixtures:

| Fixture | Expected |
|---|---|
| A5 page, TrimBox = MediaBox, 80 × 40 pt table cells (the audit repro) | `null`, falls back to the page size |
| Same table on a page that *also* has real crop marks | the crop-mark trim, not a cell |
| InDesign style: marks 3 mm off the trim, 5 mm long, 0.25 pt, plus bleed marks | the inner (trim) rectangle |
| Acrobat "Add printer marks" style (marks drawn inside a form XObject) | detected |
| Marks with 0 offset (touching the corner) | detected |
| 7 of 8 marks | detected, warning says 7 of 8 |
| Marks on a hidden layer | `null` |
| Marks outside a form's BBox | `null` |
| Dieline rectangle drawn as 4 segments on the trim, no marks | `null` |
| 3 pt thick "marks" | `null` |
| Two unrelated, non-concentric mark sets | `null` with the ambiguity warning |
| Over-budget content (generated 500k operators) | `null` with the "too complex" warning |

Also run any real crop-mark files in `test/samples/` (InDesign, Illustrator, Acrobat exports). A test is listed
in `test/samples/expected.json` (`{ "file.pdf": { "trimMm": [210, 297] } }`, also gitignored) and skipped if
the file is missing.

**Commit:** 2a, 2b and 2c together, as one change to the detector.

---

## Phase 3: seam-hiding off by default (#2)

- `src/bleed.js`: `const hide = opts.hideSeams === true;` (it's opt-in now).
- `src/index.html`:
  - Remove `checked` from `#hideSeams`.
  - Settings migration: `saveOpts` writes `o.v = 2`. `loadOpts` applies the saved `hideSeams` only when
    `o.v >= 2`, so older saved settings get the new default once.
  - Hint: "Off: the trim area is exactly as supplied. On: hides hairlines some PDF viewers show where bleed meets
    artwork, by covering the outer 0.26 mm of the trim with the mirrored edge. For on-screen proofs."
  - Help: change "(on by default)" to "(off by default)" and keep the explanation.
- README: mention the option only if it already does (it doesn't), so no change.

**Tests:** default options give the centre clip = trim and no transparency group; `hideSeams: true` still adds
the groups. **Manual:** with old `localStorage` holding `hideSeams: true`, the box loads unticked.

---

## Phase 4: output fidelity and standards (#3, #5)

### 4a. Store page content once, byte-for-byte

Replace the `PDFPageEmbedder` path in `addBleed`:
- Read `Contents` from the **source** context, not through the copier.
- **Single stream** whose dict has only `Length`, `Filter` and `DecodeParms`: build
  `PDFRawStream.of(dict, rawBytes)`, where `dict` has `Type /XObject`, `Subtype /Form`, `BBox` = MediaBox,
  `Resources` = the copied resources, plus the original `Filter` and `DecodeParms` (copied).
  `ctx.assign(ref, stream)`. The encoded bytes are untouched.
- **Array of streams**, or extra keys: decode each with `decodePDFRawStream`, join them with `\n`,
  `ctx.flateStream(...)` (the current behaviour, minus the orphan copies).
- Remove the `PDFPageLeaf` and `PDFPageEmbedder` imports if they're no longer used.

**Tests:** the output form's raw bytes equal the source's raw bytes (single stream); the output size is within
~10% of the source for the 20k-operator fixture (it was ~2×); a multi-stream page still renders the same
(decoded content equal).

### 4b. PDF/X and PDF/A: keep the claim valid (option A)

New `function standardsOf(src)` returns `{ pdfx: '1a'|'3'|'4'|null, pdfa: 1|2|3|null, version: 'M.m' }`:
- PDF/X comes from Info `GTS_PDFXVersion`, else the XMP (`pdfxid:GTS_PDFXVersion` / `pdfx:GTS_PDFXVersion`).
- PDF/A comes from XMP `pdfaid:part`.
- The version comes from `src.context.header` (`major`/`minor`). Also check the catalog `/Version`, which
  overrides the header when it's higher.

Then apply these rules in `addBleed`:

| Rule | When |
|---|---|
| `out.context.header = PDFHeader.forVersion(source major, minor)` | always for PDF sources |
| `out.save({ useObjectStreams: false })` | version < 1.5, PDF/X-1a, X-3 or PDF/A-1 |
| Seam-hiding forced off, warn "Seam hiding skipped to keep the file PDF/X-1a / PDF/A-1 valid." | X-1a, X-3 or A-1, and `hideSeams` on |
| Raise the header to 1.4 if seam groups are used and the source is < 1.4 | non-standards files only |
| Trailer `/ID`: `[<source ID[0] or random 16 bytes> <random 16 bytes>]` via `crypto.getRandomValues` | always (PDF and images) |
| XMP: new `xmpMM:InstanceID` (`uuid:` + `crypto.randomUUID()`), and `xmp:MetadataDate`/`xmp:ModifyDate` set to now. Info `/ModDate` set to the same instant | when the XMP has those fields. If the regex edit doesn't match cleanly, leave **both** the XMP and Info untouched, so they stay consistent |
| Write the edited XMP back unfiltered (`Type /Metadata`, `Subtype /XML`) | PDF/A-1 forbids filters on metadata. It's harmless otherwise |
| Warn "Source is PDF/X-4 (or PDF/A-2/3): claim kept; re-verify in Acrobat Preflight before sending." | any claim. We can't fully verify conformance ourselves |

The registration `Separation /All` with a `DeviceCMYK` alternate is allowed in PDF/X-1a, so it stays.

**Tests:** for an X-1a fixture (Info + XMP claim, header 1.3): the output header is `%PDF-1.3`, there's no
`/ObjStm`, `/ID` is present, there's no `/S /Transparency` even with `hideSeams: true` (plus the warning), and the
InstanceID differs from the source. A plain 1.7 file with `hideSeams: true` still gets groups. An image input
has an `/ID`.

**Manual verification:** run the X-1a, X-3 and X-4 outputs through Acrobat Preflight "Verify compliance". If PDF/A
files turn up in practice, run them through veraPDF.

**Commits:** 4a, then 4b.

---

## Phase 5: small fixes and wording (#4, #5 notes)

| Item | Change |
|---|---|
| Marks on the bleed | If `markOff < b`, draw the marks at `b` and warn "Trim marks moved out to the bleed edge (offset X → Y mm)". The UI shows the same note under the field |
| Misleading "No TrimBox" warning | When a TrimBox exists but equals the page: "TrimBox is the same as the page (no trim set)…". Otherwise "No TrimBox…" |
| PNG warnings | Build the reason: "with transparency" only if `hasAlpha`, "interlaced" only if `interlace`, or both |
| Grey PNG profile | When converting grey to RGB with an `iccZ`: "…converted to RGB; its greyscale colour profile was dropped" |
| JPEG coding | `parseJpeg` records the SOF marker. SOF9–SOF15 (arithmetic) → refuse: "Arithmetic-coded JPEG isn't supported by most RIPs; re-save it as a normal JPEG". `bpc` 12 → refuse in the same way |
| Huge pages | Warn if the output width or height is > 14,400 pt: "Page is larger than the 5.08 m PDF limit; some software will refuse it" |
| "Byte-for-byte" wording | After 4a: the `bleed.js` header comment, README and help say "PDF page content, fonts and images are copied unchanged (byte-for-byte for single-stream pages; multi-part page content is joined and recompressed losslessly)" |

**Tests:** one per row where it's testable in Node (all of them except the UI note).

---

## Phase 6 (optional, branch `bleed-options`): new behaviour

### 6a. Keep the file's own bleed when it's big enough

- New option `keepBleed` (checkbox "Use the file's own bleed when it has enough", on by default, saved).
- It applies only when the page has a real TrimBox (not crop marks, not Set size), and the BleedBox (or the
  CropBox/MediaBox if there's no BleedBox) extends at least `b` beyond the trim on all four sides.
- Then draw the page once, clipped to trim ± b, with no mirror pieces and no seams. Warn "Kept the file's own
  X mm bleed".
- If one side is short, mirror as now and warn "File has bleed on only some sides; mirrored bleed used instead".
- **Tests:** a fixture with a 5 mm real bleed and a 3 mm request gives the original content in the bleed (clip
  check); a fixture with 2 mm bleed and a 3 mm request gives the mirror.

### 6b. Per-file Set size

- Store `entry.trim = { mode: 'auto' | 'set', w, h }` on each entry. The Trim size panel edits the **selected**
  file. Selecting a file loads its trim settings into the panel. New files start on Auto.
- `readOpts(entry)` merges the entry's trim. A change in the trim panel reprocesses only that entry. Other
  settings still reprocess all files.
- Update the help ("applies to the selected file") and the hint.
- **Manual test:** set A to 100 × 100 and drop B: B is Auto; selecting A again shows 100 × 100.

Merge to `main` once both work.

---

## Phase 7: rollout

1. **Build stamp.** `build.mjs` reads `git rev-parse --short HEAD`, `git status --porcelain` (append "-dirty")
   and the date, and replaces `/*BUILD*/` in a new `<p class="hint">Build …</p>` line at the bottom of the help
   dialog.
2. **Pixel comparison script.** `test/render-compare.mjs`, run with `npm run check-samples`:
   - Finds Ghostscript (`gswin64c` on PATH, else `C:\Program Files\gs\*\bin\gswin64c.exe`). If there isn't
     one, it prints how to install it and exits.
   - For each PDF in `test/samples/`: run `addBleed` with seam-hiding off, using the trim it detects. Write a
     copy of the source whose TrimBox is set to that trim (pdf-lib, boxes only).
   - Render both with `-dUseTrimBox -sDEVICE=pamcmyk32 -r300`. Parse the PAM files (a text header, then raw
     CMYK) and compare. Report pixels that differ by more than 2/255 per channel. Seam-hiding is off, so there
     should be 0.
   - Write a summary table: file, trim, max difference, differing pixels, warnings.
3. **Sample set** in `test/samples/`: with and without a TrimBox; crop marks (InDesign, Illustrator, Acrobat);
   rotated pages; PDF/X-1a and X-4; spot colours with overprint; layers (some hidden); Word/Excel exports with
   tables; JPG (CMYK Adobe, EXIF-rotated) and PNG (alpha, 16-bit, indexed).
4. `npm test`, `npm run check-samples`, then spot-check three outputs in Acrobat Output Preview and Preflight.
5. Rebuild, commit, and replace every distributed `Bleedline.html` (shared drive, Pages). Check the build stamp on
   the coworkers' copy.
6. Set this doc and the audit to `status: done`, or delete them.

---

## Checklist

- [x] Phase 0: `npm test` harness, fixtures, invariants, `test/samples/` ignored
- [x] Phase 1a: option validation (bleed.js and UI)
- [x] Phase 1b: stale-download fix (markStale, run counter, entry.opts)
- [x] Phase 1c: box normalisation and TrimBox-beyond-MediaBox warning
- [x] Phase 2: strict crop-mark detection with the fixture table above
- [x] Phase 3: seam-hiding opt-in, settings migration, hint and help
- [x] Phase 4a: single byte-for-byte content copy
- [x] Phase 4b: PDF/X and PDF/A rules, trailer `/ID`, XMP instance
- [x] Phase 5: small fixes and wording
- [x] Phase 6 (optional, branch): keep existing bleed, per-file Set size
- [x] Phase 7 steps 1–2: build stamp, render comparison script
- [ ] Phase 7 steps 3–6: sample set, `npm run check-samples` (needs Ghostscript), Acrobat Preflight, redistribute, close out plans
