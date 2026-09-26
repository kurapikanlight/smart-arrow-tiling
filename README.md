# Smart Arrow Tiling

Smart Arrow Tiling is a GNOME Shell extension that supercharges the standard `Super + Arrow` window-management workflow.

It introduces intelligent window swapping, quarter-screen tiling, asymmetric 1/3 + 2/3 layouts, seamless floating-window insertion, and complementary resizing—all while cleanly restoring GNOME's original shortcuts when disabled.

## 🚀 Installation

### Quick Install

Run the following command to automatically create directories, download files, compile schemas, and enable the extension:

```bash
curl -fsSL https://raw.githubusercontent.com/kurapikanlight/smart-arrow-tiling/main/install.sh | bash
```

### Manual Installation

Copy and run this entire block in your terminal to clone, build, and enable the extension manually:

```bash
git clone https://github.com/kurapikanlight/smart-arrow-tiling.git
cd smart-arrow-tiling
mkdir -p ~/.local/share/gnome-shell/extensions/smart-arrow-tiling@kafeyn
cp extension.js metadata.json ~/.local/share/gnome-shell/extensions/smart-arrow-tiling@kafeyn/
cp -r schemas ~/.local/share/gnome-shell/extensions/smart-arrow-tiling@kafeyn/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/smart-arrow-tiling@kafeyn/schemas/
gnome-extensions enable smart-arrow-tiling@kafeyn
```

**Note:** If GNOME Shell does not detect the extension immediately, log out and log back in before enabling it.

## 🗑️ Disable & Remove

**To Disable:** (This automatically restores original GNOME keybindings)

```bash
gnome-extensions disable smart-arrow-tiling@kafeyn
```

**To Remove:** Disable the extension first, then delete the directory:

```bash
gnome-extensions disable smart-arrow-tiling@kafeyn
rm -rf ~/.local/share/gnome-shell/extensions/smart-arrow-tiling@kafeyn
```

## ✨ Features

- **Standard Tiling:** Left and right half tiling.
- **Quarter Tiling:** Four distinct quarter-screen positions.
- **Asymmetric Layouts:** 1/3 + 2/3 window configurations.
- **Smart Swapping:** Swap windows intelligently between halves, quarters, or top/bottom stacks.
- **Seamless Insertion:** Push floating windows directly into an active tiled layout.
- **Complementary Resizing:** Resize one tiled window, and its counterpart adjusts automatically.
- **Context Awareness:** Multi-window layout and per-monitor awareness.
- **Smooth Animations:** Fluid window movement transitions.
- **Safe Uninstalls:** Original GNOME shortcuts are automatically restored when disabled.

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Super + Left` | Tile or move the focused window to the left side |
| `Super + Right` | Tile or move the focused window to the right side |
| `Super + Up` | Maximize (when no tiling sequence is active) |
| `Super + Down` | Minimize (when no tiling sequence is active) |
| `Super + Left, Super + Left` | Use a left-side 1/3 layout |
| `Super + Right, Super + Right` | Use a right-side 1/3 layout |
| `Super + Left, Super + Up` | Move to the top-left quarter |
| `Super + Left, Super + Down` | Move to the bottom-left quarter |
| `Super + Right, Super + Up` | Move to the top-right quarter |
| `Super + Right, Super + Down` | Move to the bottom-right quarter |

## 🧠 Advanced Behaviors

### Smart Window Swapping

When a target area is already occupied, Smart Arrow Tiling moves the existing tiled window into the vacated position instead of letting windows overlap. Swapping is supported between:

- Left and right halves
- Quarter positions
- Top and bottom positions inside a stack
- Full-height windows and stacked windows
- Floating windows and existing tiled positions

### 1/3 + 2/3 Layouts

Pressing the same horizontal shortcut twice creates a one-third layout. The focused window is resized to approximately one-third of the monitor width, allowing other tiled windows to occupy the complementary two-thirds region. This can be initiated from either the left or right side.

### Quarter Tiling

Using horizontal and vertical shortcut sequences moves the focused window into any of the four quarters of the current monitor. The extension interprets these combinations as a fluid, single layout operation.

### Floating Window Insertion

Newly opened floating windows can be directly inserted into an existing tiled layout. If the requested area is occupied, the extension reorganizes the existing windows around the new one rather than forcing it into a half-screen position first.

### Complementary Resizing

The extension reacts natively to manual window resizing:

- **Horizontal layouts:** Resizing one side automatically adjusts compatible windows on the opposite side to consume the remaining space.
- **Vertical stacks:** Resizing one stacked window automatically adjusts its sibling to fill the remaining height.

**Note:** Pure window movement does not trigger complementary resizing.

## ⚙️ Compatibility & Under the Hood

### Native GNOME Behavior & Shortcuts

When no multi-key tiling sequence is active, `Super + Up` and `Super + Down` retain their standard maximize and minimize behaviors.

While enabled, the extension temporarily overrides GNOME's native bindings for the arrow keys. The original GNOME bindings are safely backed up and automatically restored the moment the extension is disabled.

### Supported Windows

Calculations are performed on the active workspace and monitor. Supported window types include:

- Normal application windows
- Standard dialogs
- Modal dialogs

*(Fullscreen windows are actively ignored)*

## 🛠️ Project Structure

```
smart-arrow-tiling/
├── extension.js
├── metadata.json
├── install.sh
├── README.md
├── LICENSE
└── schemas/
    └── org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml
```

## 🐛 Debugging

To troubleshoot or monitor the extension's behavior, use the following commands:

**Follow GNOME Shell logs:**

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

**Filter for Smart Arrow Tiling messages:**

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep "Smart Arrow Tiling"
```

**Check installation status:**

```bash
gnome-extensions list | grep smart-arrow
```

**Show detailed extension information:**

```bash
gnome-extensions info smart-arrow-tiling@kafeyn
```

## 👤 Author & License

**Author:** Kafeyn (@kurapikanlight)
**License:** Released under the MIT License