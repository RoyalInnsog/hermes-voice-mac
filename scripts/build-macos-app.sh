#!/usr/bin/env bash
# scripts/build-macos-app.sh — Compiles frontend, verifies backend, and packages `dist/Hermes Voice.app`
# Uses ad-hoc code signing (`codesign --force --deep --sign -`) so no paid Apple Developer ID is required.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> [1/4] Building Hermes Voice v1.0 frontend bundle (dist/)..."
npm run build

echo "==> [2/4] Running backend self-test suite..."
node server/selftest.mjs

APP_NAME="Hermes Voice.app"
APP_DIR="$ROOT_DIR/dist/$APP_NAME"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

echo "==> [3/4] Packaging macOS bundle at: $APP_DIR"
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cat > "$CONTENTS_DIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>HermesVoice</string>
  <key>CFBundleIdentifier</key>
  <string>org.nousresearch.hermes-voice</string>
  <key>CFBundleName</key>
  <string>Hermes Voice</string>
  <key>CFBundleDisplayName</key>
  <string>Hermes Voice</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Hermes Voice uses your microphone for Hinglish and English voice commands.</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Hermes Voice coordinates with local developer tools when approved.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

# Symlink or store repo path so the app bundle can auto-start server/index.mjs
ln -sf "$ROOT_DIR" "$RESOURCES_DIR/app"

if command -v swiftc >/dev/null 2>&1 && [[ "$(uname -s)" == "Darwin" ]]; then
  echo "==> Compiling native Swift WKWebView HUD (macos/HermesVoice.swift)..."
  swiftc -O "$ROOT_DIR/macos/HermesVoice.swift" \
    -framework Cocoa \
    -framework WebKit \
    -framework Carbon \
    -framework ApplicationServices \
    -o "$MACOS_DIR/HermesVoice"
else
  echo "==> swiftc not detected on this host; installing portable macOS launcher stub..."
  cat > "$MACOS_DIR/HermesVoice" <<'LAUNCHER'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
cd "$DIR"
exec node scripts/launch-hud.mjs
LAUNCHER
  chmod +x "$MACOS_DIR/HermesVoice"
fi

echo "==> [4/4] Applying ad-hoc signature..."
if command -v codesign >/dev/null 2>&1 && [[ "$(uname -s)" == "Darwin" ]]; then
  codesign --force --deep --sign - "$APP_DIR"
  echo "==> Signed with ad-hoc identity (-)."
else
  echo "==> Skipping codesign (non-Darwin environment)."
fi

echo "✅ Built: $APP_DIR"
