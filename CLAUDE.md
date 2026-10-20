# Bleedline

## Always add in-app patch notes

Every change people using the tool will notice (new feature, new or changed warning, changed behaviour, visible fix)
gets an entry in the "What's new" notes, in the same commit as the change:

- The notes are the `NOTES` array in `src/index.html` (search for `What's new`). Newest first.
- Add a new entry at the top with a unique `id` (`YYYY-MM-DD`, add `-2` etc. for a second release the same day)
  and a readable `date`, or add an item to the top entry if it hasn't been pushed yet.
- Write for the print-room user: what changed and what to do about it, in a sentence or two. No code or internals.
- Each browser shows unseen entries once on load, so a new `id` is what makes the box appear after an update.
- Skip it only for changes nobody would notice (refactors, tests, build tweaks).

## Build

`Bleedline.html` is generated from `src/`: run `npm run build` after changes, and `npm test`. The repo's habit is a
separate "Rebuild with clean build stamp" commit after the change is committed, so the stamp isn't `-dirty`.
GitHub Pages serves `main` root, so pushing `main` deploys.
