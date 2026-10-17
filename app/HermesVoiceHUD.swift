// app/HermesVoiceHUD.swift — Hermes Voice v1.0 Native macOS Floating HUD & Menu-Bar Shell (Spec §2.3).
//
// Zero external dependencies. Compiles with standard macOS Command Line Tools:
//   swiftc app/HermesVoiceHUD.swift -o "dist/Hermes Voice.app/Contents/MacOS/HermesVoice" \
//     -framework Cocoa -framework WebKit -framework Carbon -O
//
// Capabilities:
//   • Menu-bar status item (NSStatusBar) with quick actions
//   • Floating borderless/HUD NSPanel (420x680 compact HUD <-> 1220x780 full console)
//   • Pinned to top-right of active screen, joins all Spaces & full-screen apps
//   • Global hotkey (⌥ Space) via Carbon RegisterEventHotKey to toggle HUD & start listening
//   • Auto-grants WKWebView microphone permission on macOS 12+ (requestMediaCapturePermissionFor)
//   • Auto-spawns `node server/index.mjs` if 127.0.0.1:20130 is not already listening

import Cocoa
import WebKit
import Carbon

private var sharedAppDelegate: AppDelegate?

private func hotKeyHandler(
    nextHandler: EventHandlerCallRef?,
    theEvent: EventRef?,
    userData: UnsafeMutableRawPointer?
) -> OSStatus {
    DispatchQueue.main.async {
        sharedAppDelegate?.handleGlobalHotkey()
    }
    return noErr
}

final class FloatingHUDPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var statusItem: NSStatusItem!
    var panel: FloatingHUDPanel!
    var webView: WKWebView!
    var bridgeProcess: Process?
    var isExpanded = false
    var hotKeyRef: EventHotKeyRef?
    let bridgeURL = URL(string: "http://127.0.0.1:20130")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        sharedAppDelegate = self
        NSApp.setActivationPolicy(.accessory) // LSUIElement menu-bar style (no Dock clutter)

        setupMenuBar()
        setupFloatingPanel()
        registerGlobalHotKey()
        ensureBridgeThenLoad()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let proc = bridgeProcess, proc.isRunning {
            proc.terminate()
        }
    }

    // MARK: - Menu Bar Status Item

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            if #available(macOS 11.0, *),
               let img = NSImage(systemSymbolName: "waveform.circle.fill", accessibilityDescription: "Hermes Voice") {
                button.image = img
            } else {
                button.title = "🎙 HV"
            }
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Toggle Hermes Voice HUD (⌥Space)", action: #selector(togglePanel), keyEquivalent: " "))
        menu.addItem(NSMenuItem(title: "Switch HUD / Full Console Size", action: #selector(toggleSize), keyEquivalent: "f"))
        menu.addItem(NSMenuItem(title: "Reload UI (127.0.0.1:20130)", action: #selector(reloadWebView), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit Hermes Voice", action: #selector(quitApp), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    // MARK: - Floating NSPanel + WKWebView

    private func setupFloatingPanel() {
        let hudSize = NSSize(width: 420, height: 680)
        let screenRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let origin = NSPoint(
            x: screenRect.maxX - hudSize.width - 20,
            y: screenRect.maxY - hudSize.height - 20
        )

        panel = FloatingHUDPanel(
            contentRect: NSRect(origin: origin, size: hudSize),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Hermes Voice"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.backgroundColor = NSColor(red: 0.055, green: 0.051, blue: 0.043, alpha: 1.0) // #0e0d0b
        panel.isMovableByWindowBackground = true
        panel.hasShadow = true

        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: panel.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        panel.contentView?.addSubview(webView)
        panel.makeKeyAndOrderFront(nil)
    }

    // Auto-grant microphone permission inside WKWebView on macOS 12+
    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }

    // MARK: - Global Hotkey (⌥ Space)

    private func registerGlobalHotKey() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetApplicationEventTarget(),
            hotKeyHandler,
            1,
            &eventType,
            nil,
            nil
        )
        let hotKeyID = EventHotKeyID(signature: OSType(0x48564F49), id: 1) // 'HVOI'
        RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
    }

    func handleGlobalHotkey() {
        if !panel.isVisible {
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('hv-global-hotkey'));", completionHandler: nil)
    }

    // MARK: - Bridge Auto-Start & Loading

    private func ensureBridgeThenLoad() {
        let healthURL = URL(string: "http://127.0.0.1:20130/api/health")!
        let task = URLSession.shared.dataTask(with: healthURL) { [weak self] _, response, _ in
            guard let self = self else { return }
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                DispatchQueue.main.async {
                    self.webView.load(URLRequest(url: self.bridgeURL))
                }
            } else {
                self.spawnLocalBridge()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    self.webView.load(URLRequest(url: self.bridgeURL))
                }
            }
        }
        task.resume()
    }

    private func spawnLocalBridge() {
        guard bridgeProcess == nil else { return }
        if let repoRoot = ProcessInfo.processInfo.environment["HV_REPO_ROOT"] {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", "\(repoRoot)/server/index.mjs"]
            proc.currentDirectoryURL = URL(fileURLWithPath: repoRoot)
            try? proc.run()
            bridgeProcess = proc
        }
    }

    // MARK: - Actions

    @objc func togglePanel() {
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc func toggleSize() {
        isExpanded.toggle()
        let screenRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let newSize = isExpanded ? NSSize(width: 1220, height: 780) : NSSize(width: 420, height: 680)
        let newOrigin = isExpanded
            ? NSPoint(x: screenRect.midX - newSize.width / 2, y: screenRect.midY - newSize.height / 2)
            : NSPoint(x: screenRect.maxX - newSize.width - 20, y: screenRect.maxY - newSize.height - 20)
        panel.setFrame(NSRect(origin: newOrigin, size: newSize), display: true, animate: true)
    }

    @objc func reloadWebView() {
        webView.load(URLRequest(url: bridgeURL))
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
