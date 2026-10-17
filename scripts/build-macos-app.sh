#!/usr/bin/env bash
# scripts/build-macos-app.sh — Hermes Voice v1.0 macOS Application Packager (Spec §2.3 & §3.5).
#
# Usage:
#   bash scripts/build-macos-app.sh
#
# Output:
#   dist/Hermes Voice.app   (ad-hoc signed with `codesign -s -`, ₹0 / $0 cost)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="Hermes Voice"
APP_BUNDLE="$ROOT/dist/${APP_NAME}.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

echo "== [1/4] Building production frontend bundle (dist/index.html) =="
npm run build

echo "== [2/4] Running backend self-test suite (server/selftest.mjs) =="
node server/selftest.mjs

echo "== [3/4] Assembling ${APP_NAME}.app bundle structure =="
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RES_DIR"

cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Hermes Voice</string>
  <key>CFBundleDisplayName</key>
  <string>Hermes Voice</string>
  <key>CFBundleIdentifier</key>
  <string>com.sonisahab.hermesvoice</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>HermesVoice</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Hermes Voice needs microphone access for hands-free Hinglish voice commands and tool approvals.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Hermes Voice uses speech recognition to transcribe your voice commands for the Hermes Agent.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

# Write a launcher wrapper that sets HV_REPO_ROOT and launches either the compiled
# Swift WKWebView HUD binary or a fallback standalone window.
if command -v swiftc >/dev/null 2>&1 && [[ "$(uname -s)" == "Darwin" ]]; then
  echo "== [4/4] Compiling native WKWebView Floating HUD (app/HermesVoiceHUD.swift) =="
  swiftc "$ROOT/app/HermesVoiceHUD.swift" \
    -o "$MACOS_DIR/HermesVoice-bin" \
    -framework Cocoa -framework WebKit -framework Carbon -O

  cat > "$MACOS_DIR/HermesVoice" <<EOF
#!/usr/bin/env bash
export HV_REPO_ROOT="$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH"
exec "\$(dirname "\$0")/HermesVoice-bin"
EOF
  chmod +x "$MACOS_DIR/HermesVoice" "$MACOS_DIR/HermesVoice-bin"
else
  echo "== [4/4] swiftc not detected on this host; installing portable macOS launcher script =="
  cat > "$MACOS_DIR/HermesVoice" <<EOF
#!/usr/bin/env bash
export HV_REPO_ROOT="$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH"
if ! curl -s -m 1 http://127.0.0.1:20130/api/health >/dev/null 2>&1; then
  nohup node "$ROOT/server/index.mjs" >/tmp/hermes-voice-bridge.log 2>&1 &
  sleep 1
fi
if [[ "\$(uname -s)" == "Darwin" ]]; then
  open "http://127.0.0.1:20130"
else
  echo "Hermes Voice running at http://127.0.0.1:20130"
fi
EOF
  chmod +x "$MACOS_DIR/HermesVoice"
fi

if command -v codesign >/dev/null 2>&1 && [[ "$(uname -s)" == "Darwin" ]]; then
  echo "== Ad-hoc signing ${APP_BUNDLE} (codesign --force --deep --sign -) =="
  codesign --force --deep --sign - "$APP_BUNDLE"
fi

echo ""
echo "✓ Built: $APP_BUNDLE"
echo "  Run server + UI directly:  node server/index.mjs"
echo "  Open macOS Floating HUD:   open \"$APP_BUNDLE\""
