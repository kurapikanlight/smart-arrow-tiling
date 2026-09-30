# Smart Arrow Tiling

Predictable keyboard tiling and a compact drag-to-top layout selector for **GNOME Shell 50**.

Smart Arrow tracks window ownership in explicit slots, separately for each workspace and monitor. A command commits the complete new layout before requesting window movement, so a slow Wayland client cannot change which window is swapped next.

## Install

From this checkout:

```bash
bash install.sh
```

After installing or updating, log out and back in to load the new JavaScript. Then, if needed, run:

```bash
gnome-extensions enable smart-arrow-tiling@kafeyn
```

The installer requires `gnome-extensions` and `glib-compile-schemas`. It stages and validates files before replacing the installed copy. It preserves extension preferences and does not permanently rewrite desktop shortcuts.

## Keyboard

| Shortcut | Action |
|---|---|
| Super + Left / Right | Immediately tile or move toward that column, restore half widths, exchange occupied slots |
| Super + Left, Left / Right, Right | Put the focused window in a third, with the others in the complementary two-thirds |
| Super + Left, Up / Down | Select the top-left / bottom-left slot |
| Super + Right, Up / Down | Select the top-right / bottom-right slot |
| Super + Up / Down | Move between upper/lower slots in the current column |

Keep Super held and press the sequence keys within 320 ms. The first key acts immediately; the second refines that command. One horizontal press after a third-width command restores halves. A focus change cancels a pending sequence. Vertical commands leave a full-height window unchanged unless they complete a diagonal sequence. Third-width commands do not collapse a four-window group.

Existing maximize/minimize shortcuts remain available unless they conflict with Super+Arrow. Conflicting bindings and native edge tiling are temporarily released while Smart Arrow is enabled, then restored on disable. Changes you make to those settings while it is active are respected.

**Upgrade note:** previous releases permanently replaced desktop shortcuts. This version can restore the settings present when it enables; it cannot reconstruct custom bindings erased by an older installer.

## Layouts and swapping

- Two columns, including adjustable 1/3–2/3 proportions.
- Left primary: one full-height window on the left, two stacked on the right.
- Right primary: two stacked on the left, one full-height window on the right.
- Four quarters, with independently adjustable vertical dividers.

An occupied quarter exchanges owners with the source slot. Moving a quarter into the opposite full-height column splits that column and expands the remaining source sibling. Moving a full column horizontally exchanges it with the opposite column, including both stacked windows.

For example, with A on the left and B above C on the right, focusing C and pressing Super+Left, Up produces C above A on the left and B full-height on the right.

Diagonal placement can leave an empty quarter ready for another window. A fifth window stays floating rather than displacing an existing owner. Existing floating windows are not automatically adopted based on their screen coordinates; tile them with a shortcut or a drop.

## Drag and resize

Start dragging a normal window: the layout selector appears immediately at the top of that monitor, including when dragging from maximized. There is no panel icon to locate. Hover a zone in one of the four miniature layouts and release. The highlighted screen region shows the resulting geometry. Layouts with fewer slots than the group needs are dimmed and cannot accept the drop. Moving away clears the selection; the selector stays visible until the drag ends. Escape cancels it.

Keyboard and drop placement use the same transition engine. Dragging out without selecting a zone removes the window from the group. Resizing an internal divider adjusts adjacent tiles. Closing, minimizing, maximizing, or moving a window to another workspace releases its slot and reflows its remaining column. A maximized window can be tiled again normally.

Tiles use the workspace's **work area**, including reserved panel/dock space, with a **1 logical pixel** gap between adjacent frames (scaled by GNOME on HiDPI displays). Fullscreen windows, sticky windows, dialogs and non-resizable windows are not managed. Monitor topology changes clear ownership; retile on the new topology. Layout ownership is session-local and is rebuilt through tiling commands after enabling.

Window changes use a short 120 ms snapshot transition; actual geometry is submitted immediately. The extension does not animate or freeze live window actors. Snapshots are removed on another move, grab, close or disable. Live divider resizing skips snapshot animation, and GNOME's animation setting is respected. Repeated identical target rectangles are not resent to clients; pending updates use the latest target.

## Development and checks

No npm dependencies or build framework are needed. With a recent Node.js (tested with 24):

```bash
node --test tests/*.test.mjs
bash -n install.sh
```

- `layout.js`: four topology definitions, pure transitions, divider ratios and shared geometry mapper.
- `extension.js`: GNOME lifecycle, shortcuts, window signals, grabs and applying geometry.
- `snapOverlay.js` + `stylesheet.css`: presentation and pointer hit testing; all layout decisions come from `layout.js`.
- `tests/`: permutations, exact swaps, geometry, adapter lifecycle, overlay and isolated installer checks.

The exhaustive test covers all **1,088** fully occupied layout permutations, focused windows and eight directional commands. Additional regressions cover rapid commands before frame acknowledgements, partial layouts, third widths, shared resizing, workspace/monitor isolation, maximize, canceled/closed drags, setting restoration and installation failure.

### GNOME 50 smoke test

Automated adapter tests use lightweight GNOME doubles; they do **not** replace a live compositor test. Before release:

1. Tile two windows and swap them repeatedly, including rapid alternating commands.
2. Add a third; reproduce the A/B/C example above in both directions. Add a fourth and swap diagonally and vertically.
3. Resize internal horizontal and vertical dividers with different applications, including ones with minimum-size constraints.
4. Tile from maximized; maximize, minimize, close, and retile group members.
5. Drag to every preview zone; drag away, press Escape, and close a floating window mid-drag.
6. Repeat across two monitors (including negative offsets/scaling) and two workspaces; test monitor removal.
7. Disable and re-enable; verify shortcuts and native edge tiling return to their prior settings and no overlay remains.

Applications may enforce minimum sizes or asynchronous configure behavior. Logical geometry is tested for non-overlap, but physical client behavior and Shell animations still require the smoke test above. A real GJS session and native schema compiler were not available in the development environment; schema XML and installer flow were checked separately.

## Design and investigation

[Editable snap interface in Figma](https://www.figma.com/design/hFv8eh7BtG2PuZOh5nS5jp?node-id=2-2)

The previous implementation captured a physical source rectangle at keypress but used pending target rectangles for peers. During an unsettled swap, the next diagonal could therefore combine old and new state, misidentify its source column and return early or select the wrong owner. Geometry classification also admitted unrelated edge-aligned windows, and used whole-monitor bounds. Explicit ownership removes those ambiguities; work-area mapping fixes the bounds independently.

Relevant native mechanisms were checked through Context7 and Mutter 50.0 source. Focused reference reading covered Tiling Shell's snap assistant and resize signal handling, and HakuSpace's distinction between moving windows and moving whole columns. No external tiling framework or runtime dependency is added.

## Debug

```bash
journalctl --user -f -o cat | grep 'Smart Arrow Tiling'
gnome-extensions info smart-arrow-tiling@kafeyn
```

Licensed under the included [LICENSE](LICENSE).
