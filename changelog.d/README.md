# Changelog fragments

A branch does not edit `CHANGELOG.md`. It puts its user-facing entry in a file
of its own here, `changelog.d/<branch-topic>.md` (for the branch
`work/camera-rear`, a file named camera-rear.md), and the release script folds every fragment
into `CHANGELOG.md` when the release is bumped, then deletes them.

Why: every branch used to add its bullet under `## Unreleased` at the same
place in the same file, so every merge conflicted there. A release merging
five branches meant five hand resolutions of one section, and a resolution
that kept both sides of an edit, or cut a bullet off mid-sentence, shipped to
users (the checks in `scripts/check-docs-consistency.mjs` exist because it
did). A file per branch cannot conflict with another branch's.

A fragment holds only what a release section's body holds:

```markdown
### Fixed

- **The camera's flip switches to the rear camera.** What was wrong, in the
  user's words, what is true now, and what they need (an update, a new APK).
```

- Headings: `### Added`, `### Changed`, `### Fixed`, `### Removed`,
  `### Security`, in any order and only the ones you need.
- Bullets: `- **Lead sentence.** Rest of the entry.`, the same style as
  `CHANGELOG.md`; a long bullet may continue on lines indented by two spaces.
- No `## ` heading: the release script writes the version and date.
- One bullet per subject across every fragment and `## Unreleased` (`npm run
  lint` fails a duplicate, and a bullet that stops mid-sentence).
- Change your own fragment as your branch changes; never another branch's.

At release, entries are grouped under their headings in the order Added,
Changed, Fixed, Removed, Security, after anything already under
`## Unreleased`, fragment by fragment in file-name order.
