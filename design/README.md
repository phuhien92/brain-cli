# Brain design handoff

`design/brain-ui.pen` is the canonical editable source for Brain UI and brand work. `design/tokens.json` is the machine-readable token and brand contract. External review exports are derived evidence, not sources to copy back into the repository.

## Implemented brand

Direction **A · Linked Vault** is implemented:

- both the app-icon tile and banner field use `brand.background` → `color.action` (`#21C995`);
- brackets, graph, edge strokes and banner copy use `brand.onBackground` → `color.actionText` (`#052F3E`);
- paper nodes use `brand.paper` with an `onBackground` outline so their shape does not rely on low-contrast fill;
- the wordmark uses Manrope 750 for `brain` and IBM Plex Mono SemiBold for `-cli`;
- display wordmark glyphs in `assets/banner.svg` are deterministic vector paths, not installed-font-dependent `<text>`;
- indigo, lavender, amber identity colors, gradients, decorative graphs and feature pills are not part of the approved direction.

The implementation outputs are `assets/logo.svg` and `assets/banner.svg`. The canonical mark geometry and 1280 × 320 banner contract are recorded in `design/tokens.json`. The banner keeps the exact positioning copy:

> Headless memory for your markdown vault.<br>
> For any agent, on any machine.

## Typography portability

The outlined display wordmark preserves the intended Manrope / IBM Plex Mono pairing on every renderer. Supporting banner copy deliberately remains live text and uses the portable stacks declared by `font.portableSans` and `font.portableMono`; the approved Pen banner demonstrates the same behavior with Arial and Menlo.

## Icon use

- Use the canonical linked-note graph at every size, paired with a visible `brain-cli` or navigation label.
- At 16 px, scale the same mark for browser tabs and tiny avatars without changing its geometry.
- Use one identity mark per structural chrome region. Do not repeat it in cards, status pills or list rows.
- The approved desktop sidebar, browser-tab and compact phone-header placements are on board 17 in the Pen file.

## Banner use

Use the full 4:1 banner at 640 px wide or larger. Below that, use the icon and wordmark lockup. Preserve one icon-width of clear space and keep product proof subordinate to the tagline.

## Accessibility and fallback

`brand.onBackground` against `brand.background` is 6.65:1, passing WCAG AA for normal text. The paper node fill is not treated as sufficient contrast against green; its dark outline carries the edge contrast. The one-color fallback uses the same bracket-and-graph silhouette in one ink plus paper.

## Maintaining the source

1. Start visual changes in `design/brain-ui.pen` with the Pen CLI.
2. Update `design/tokens.json` when a semantic token or asset contract changes.
3. Export or reproduce repository SVGs from the approved Pen direction without introducing off-token colors.
4. Keep the Pen lifecycle metadata, banner dimensions, background role and canonical mark geometry aligned with the shipped SVGs.
5. Keep product UI behavior out of a brand-only change.
6. Run `npm test` before committing.
