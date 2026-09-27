#!/usr/bin/env bash
set -euo pipefail

UUID="smart-arrow-tiling@kafeyn"
SCHEMA="org.gnome.shell.extensions.smart-arrow-tiling"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
REPO_RAW="https://raw.githubusercontent.com/kurapikanlight/smart-arrow-tiling/main"

say() {
    printf '%s\n' "$*"
}

need() {
    command -v "$1" >/dev/null 2>&1 || {
        printf 'Missing required command: %s\n' "$1" >&2
        exit 1
    }
}

need gsettings
need gnome-extensions
need glib-compile-schemas

# Disable the old copy before replacing files. Ignore "not installed" errors.
gnome-extensions disable "$UUID" >/dev/null 2>&1 || true

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/schemas"

# When run from a cloned repository, install those exact local files.
# When piped through curl, fetch the current files from GitHub.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

if [[ -n "$SCRIPT_DIR" \
      && -f "$SCRIPT_DIR/extension.js" \
      && -f "$SCRIPT_DIR/metadata.json" \
      && -f "$SCRIPT_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml" ]]; then
    cp "$SCRIPT_DIR/extension.js" "$TMP_DIR/extension.js"
    cp "$SCRIPT_DIR/metadata.json" "$TMP_DIR/metadata.json"
    cp "$SCRIPT_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml" \
       "$TMP_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml"
else
    need curl
    curl -fsSL "$REPO_RAW/extension.js" -o "$TMP_DIR/extension.js"
    curl -fsSL "$REPO_RAW/metadata.json" -o "$TMP_DIR/metadata.json"
    curl -fsSL \
        "$REPO_RAW/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml" \
        -o "$TMP_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml"
fi

# Clean install: do not leave old JS, old schemas, or compiled schema files behind.
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR/schemas"
cp "$TMP_DIR/extension.js" "$EXT_DIR/extension.js"
cp "$TMP_DIR/metadata.json" "$EXT_DIR/metadata.json"
cp "$TMP_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml" \
   "$EXT_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml"

glib-compile-schemas --strict "$EXT_DIR/schemas"

# ------------------------------------------------------------
# Permanent key ownership
# ------------------------------------------------------------
# GNOME owns only Alt+Up / Alt+Down for maximize/minimize.
# Remove GNOME's native Super+Arrow tiling so Smart Arrow is the
# only owner of Super+Left/Right/Up/Down.
gsettings set org.gnome.desktop.wm.keybindings maximize "['<Alt>Up']"
gsettings set org.gnome.desktop.wm.keybindings minimize "['<Alt>Down']"
gsettings set org.gnome.desktop.wm.keybindings unmaximize "@as []"
gsettings set org.gnome.mutter.keybindings toggle-tiled-left "@as []"
gsettings set org.gnome.mutter.keybindings toggle-tiled-right "@as []"

# Clear old Smart Arrow settings from previous versions, including
# the old saved/restore binding state, then force the clean defaults.
GSETTINGS_SCHEMA_DIR="$EXT_DIR/schemas" \
    gsettings reset-recursively "$SCHEMA" || true

GSETTINGS_SCHEMA_DIR="$EXT_DIR/schemas" \
    gsettings set "$SCHEMA" tile-left "['<Super>Left']"
GSETTINGS_SCHEMA_DIR="$EXT_DIR/schemas" \
    gsettings set "$SCHEMA" tile-right "['<Super>Right']"
GSETTINGS_SCHEMA_DIR="$EXT_DIR/schemas" \
    gsettings set "$SCHEMA" tile-up "['<Super>Up']"
GSETTINGS_SCHEMA_DIR="$EXT_DIR/schemas" \
    gsettings set "$SCHEMA" tile-down "['<Super>Down']"

say ""
say "Smart Arrow Tiling installed cleanly."
say ""
say "GNOME:"
say "  Alt+Up    -> maximize"
say "  Alt+Down  -> minimize"
say ""
say "Smart Arrow Tiling:"
say "  Super+Left / Super+Right       -> horizontal smart tiling"
say "  Super+Left/Right then Up/Down -> quarter movement"
say "  Super+Left/Right twice         -> 1/3 + 2/3"
say "  standalone Super+Up/Down       -> intentionally no action"
say ""

if gnome-extensions enable "$UUID" >/dev/null 2>&1; then
    say "Extension enabled."
else
    say "GNOME has not loaded the freshly installed extension yet."
    say "Log out and back in once, then run:"
    say "  gnome-extensions enable $UUID"
fi
