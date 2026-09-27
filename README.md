# Smart Arrow Tiling

Smart Arrow Tiling is a GNOME Shell 50 extension for predictable keyboard tiling without taking over GNOME's maximize/minimize shortcuts.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Super + Left` | Smart move/tile left |
| `Super + Right` | Smart move/tile right |
| `Super + Left, Left` | Left 1/3 + complementary 2/3 |
| `Super + Right, Right` | Right 1/3 + complementary 2/3 |
| `Super + Left, Up` | Top-left / atomic slot move |
| `Super + Left, Down` | Bottom-left / atomic slot move |
| `Super + Right, Up` | Top-right / atomic slot move |
| `Super + Right, Down` | Bottom-right / atomic slot move |
| `Alt + Up` | GNOME maximize |
| `Alt + Down` | GNOME minimize |

Standalone `Super + Up` and `Super + Down` are intentionally reserved by the extension and do nothing unless they complete a left/right tiling sequence.

## Clean install

```bash
chmod +x install.sh
./install.sh
```

The installer deliberately enforces:

- GNOME maximize = `Alt + Up`
- GNOME minimize = `Alt + Down`
- GNOME unmaximize shortcut = empty
- GNOME native left/right tiling shortcuts = empty
- Smart Arrow owns `Super + Left/Right/Up/Down`

## Design changes in v11

- No backup/restore of GNOME shortcuts inside `extension.js`.
- No standalone maximize/minimize code inside Smart Arrow.
- Atomic quarter swaps: diagonal swaps are planned as one operation.
- Vacated source columns are reflowed immediately.
- Manual divider resizing updates neighboring windows live.
- No animation layer; geometry is direct and retried briefly for Wayland/client settling.
- Four-window grids are not collapsed by the 1/3 shortcut.

## Debug

```bash
journalctl --user -f -o cat | grep "Smart Arrow Tiling"
```

Check status:

```bash
gnome-extensions info smart-arrow-tiling@kafeyn
```
