#!/usr/bin/env bash

set -euo pipefail

# ============================================================
# Smart Arrow Tiling
# GNOME Shell Extension Installer
#
# UUID:
# smart-arrow-tiling@kafeyn_
# ============================================================

UUID="smart-arrow-tiling@kafeyn"
REPO="kurapikanlight/smart-arrow-tiling"
BRANCH="main"

INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SCHEMA_DIR="$INSTALL_DIR/schemas"

RAW_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

echo
echo "=========================================="
echo " Smart Arrow Tiling"
echo " GNOME Shell Extension Installer"
echo "=========================================="
echo

# ------------------------------------------------------------
# Check dependencies
# ------------------------------------------------------------

if ! command -v curl >/dev/null 2>&1; then
    echo "Error: curl is required."
    echo
    echo "Fedora:"
    echo "  sudo dnf install curl"
    echo
    exit 1
fi

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
    echo "Error: glib-compile-schemas is required."
    echo
    echo "Fedora:"
    echo "  sudo dnf install glib2"
    echo
    exit 1
fi

# ------------------------------------------------------------
# Show GNOME version
# ------------------------------------------------------------

if command -v gnome-shell >/dev/null 2>&1; then
    echo "Detected:"
    gnome-shell --version || true
    echo
fi

# ------------------------------------------------------------
# Create extension directory
# ------------------------------------------------------------

echo "[1/5] Creating extension directory..."

mkdir -p "$INSTALL_DIR"
mkdir -p "$SCHEMA_DIR"

# ------------------------------------------------------------
# Download extension.js
# ------------------------------------------------------------

echo "[2/5] Downloading extension.js..."

curl \
    -fsSL \
    "$RAW_URL/extension.js" \
    -o "$INSTALL_DIR/extension.js"

# ------------------------------------------------------------
# Download metadata.json
# ------------------------------------------------------------

echo "[3/5] Downloading metadata.json..."

curl \
    -fsSL \
    "$RAW_URL/metadata.json" \
    -o "$INSTALL_DIR/metadata.json"

# ------------------------------------------------------------
# Download schema
# ------------------------------------------------------------

echo "[4/5] Downloading GSettings schema..."

curl \
    -fsSL \
    "$RAW_URL/schemas/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml" \
    -o "$SCHEMA_DIR/org.gnome.shell.extensions.smart-arrow-tiling.gschema.xml"

# ------------------------------------------------------------
# Compile schema
# ------------------------------------------------------------

echo "[5/5] Compiling GSettings schema..."

glib-compile-schemas "$SCHEMA_DIR"

# ------------------------------------------------------------
# Enable extension if possible
# ------------------------------------------------------------

echo
echo "Installation completed successfully."
echo

if command -v gnome-extensions >/dev/null 2>&1; then

    echo "Trying to enable Smart Arrow Tiling..."

    if gnome-extensions enable "$UUID" 2>/dev/null; then
        echo
        echo "Smart Arrow Tiling is enabled."
    else
        echo
        echo "The extension was installed, but GNOME Shell"
        echo "has not loaded it yet."
        echo
        echo "Log out and log back in, then run:"
        echo
        echo "  gnome-extensions enable $UUID"
    fi

else
    echo "gnome-extensions command was not found."
    echo
    echo "After logging back into GNOME, enable:"
    echo
    echo "  $UUID"
fi

echo
echo "Installed to:"
echo
echo "  $INSTALL_DIR"
echo
echo "------------------------------------------"
echo " Smart Arrow Tiling installation complete"
echo "------------------------------------------"
echo