# Brain design handoff

`design/brain-ui.pen` is the canonical editable source for Brain UI and brand work. `design/tokens.json` is the machine-readable token contract. External review exports are history, not sources to copy back into the repository.

## Approved brand

Direction **A · Linked Vault** is approved:

- a flat `brand.field` tile;
- double wiki-link brackets in `brand.bracket`;
- a linked-note graph with `brand.signal` as its active connection;
- Manrope `brain` plus IBM Plex Mono `-cli` for the wordmark;
- no indigo, lavender, amber identity color, gradient, decorative graph, or feature pill.

The implementation outputs are `assets/logo.svg` and `assets/banner.svg`. The banner keeps the exact positioning copy:

> Headless memory for your markdown vault.<br>
> For any agent, on any machine.

## Icon use

- Use the full graph at 32 px and above, paired with a visible `brain-cli` or navigation label.
- Use the bracket-plus-focus-node micro-glyph at 16 px for browser tabs and tiny avatars.
- Use one identity mark per structural chrome region. Do not repeat it in cards, status pills, or list rows.
- The approved desktop sidebar, browser-tab, and compact phone-header placements are on board 17 in the Pen file.

## Banner use

Use the full 4:1 banner at 640 px wide or larger. Below that, use the icon and wordmark lockup. Preserve one icon-width of clear space and keep product proof subordinate to the tagline.

## Maintaining the source

1. Start visual changes in `design/brain-ui.pen` with the Pen CLI.
2. Update `design/tokens.json` when a semantic token changes.
3. Export or reproduce repository SVGs from the approved Pen direction without introducing off-token colors.
4. Keep product UI behavior out of a brand-only change.
5. Run `npm test` before committing.

Text contrast pairs used by the approved direction are at least 6.55:1. The 16 px mark is symbolic and must not replace its adjacent text label.
