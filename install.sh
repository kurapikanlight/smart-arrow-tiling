#!/usr/bin/env bash
set -euo pipefail

UUID="smart-arrow-tiling@kafeyn"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
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

need gnome-extensions
need glib-compile-schemas

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
    for file in extension.js layout.js snapOverlay.js stylesheet.css; do
        cp "$SCRIPT_DIR/$file" "$TMP_DIR/$file"
    done
    cp "$SCRIPT_DIR/metadata.json" "$TMP_DIR/metadata.json"
    cp "$SCRIPT_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml" \
       "$TMP_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml"
else
    need curl
    for file in extension.js layout.js snapOverlay.js stylesheet.css; do
        curl -fsSL "$REPO_RAW/$file" -o "$TMP_DIR/$file"
    done
    curl -fsSL "$REPO_RAW/metadata.json" -o "$TMP_DIR/metadata.json"
    curl -fsSL \
        "$REPO_RAW/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml" \
        -o "$TMP_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml"
fi

# Validate the staged schema before touching the working installation.
glib-compile-schemas --strict "$TMP_DIR/schemas"
gnome-extensions disable "$UUID" >/dev/null 2>&1 || true

# Clean install: do not leave old JS or schemas behind.
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR/schemas"
for file in extension.js layout.js snapOverlay.js stylesheet.css; do
    cp "$TMP_DIR/$file" "$EXT_DIR/$file"
done
cp "$TMP_DIR/metadata.json" "$EXT_DIR/metadata.json"
cp "$TMP_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml" \
   "$EXT_DIR/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml"

cp "$TMP_DIR/schemas/gschemas.compiled" "$EXT_DIR/schemas/gschemas.compiled"

# Key ownership is temporary and managed by enable()/disable().
# Preserve the user's extension settings during updates.

say ""
say "Smart Arrow Tiling installed cleanly."
say ""
say "GNOME:"
say "  Existing maximize/minimize bindings are preserved where non-conflicting."
say "  Conflicting Super+Arrow bindings are restored on disable."
say ""
say "Smart Arrow Tiling:"
say "  Super+Left / Super+Right       -> horizontal smart tiling"
say "  Super+Left/Right then Up/Down -> quarter movement"
say "  Super+Left/Right twice         -> 1/3 + 2/3"
say "  standalone Super+Up/Down       -> swap vertical slots"
say ""

if gnome-extensions enable "$UUID" >/dev/null 2>&1; then
    say "Extension enabled. Log out and back in to load the updated JavaScript."
else
    say "GNOME has not loaded the freshly installed extension yet."
    say "Log out and back in once, then run:"
    say "  gnome-extensions enable $UUID"
fi
