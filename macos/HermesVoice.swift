// macos/HermesVoice.swift — Native macOS Floating HUD & Menu Bar Wrapper (Hermes Voice v1.0)
//
// Zero external dependencies. Compiles with Apple's built-in `swiftc`:
//   swiftc -O macos/HermesVoice.swift -framework Cocoa -framework WebKit -framework Carbon -o "dist/Hermes Voice.app/Contents/MacOS/HermesVoice"
//
// Features:
//   • Floating 420x680 borderless dark HUD panel (NSPanel) pinned to top-right / center overlay
//   • WKWebView connected to http://127.0.0.1:20130/?hud=1 with automatic microphone permission grant
//   • NSStatusBar menu bar icon ("✦ HV") with quick controls
//   • Global hotkey `⌥ Space` (Option + Space) via Carbon RegisterEventHotKey
//   • Graceful Accessibility permission check (AXIsProcessTrustedWithOptions) without blocking or crashing
//   • Automatic background spawning of `node server/index.mjs` if port 20130 is not yet listening

import Cocoa
import WebKit
import Carbon
import ApplicationServices

final class HUDPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    private var panel: HUDPanel!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var bridgeProcess: Process?
    private var hotKeyRef: EventHotKeyRef?
    private let bridgeURL = URL(string: "http://127.0.0.1:20130/?hud=1")!
    private let workspaceURL = URL(string: "http://127.0.0.1:20130/")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        ensureBridgeRunning()
        setupStatusItem()
        setupFloatingPanel()
        registerGlobalHotKey()
        checkAccessibilityPermissions(prompt: false)
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let hotKeyRef = hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
        }
        if let proc = bridgeProcess, proc.isRunning {
            proc.terminate()
        }
    }

    // MARK: - Bridge Auto-Start

    private func ensureBridgeRunning() {
        let healthURL = URL(string: "http://127.0.0.1:20130/api/health")!
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 0.8

        let sem = DispatchSemaphore(value: 0)
        var alive = false
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                alive = true
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.0)

        if alive { return }

        // Resolve repository root relative to bundle or current directory
        let bundlePath = Bundle.main.bundlePath
        var candidates: [String] = []
        if let res = Bundle.main.resourcePath {
            candidates.append("\(res)/app")
        }
        candidates.append(URL(fileURLWithPath: bundlePath).deletingLastPathComponent().deletingLastPathComponent().path)
        candidates.append(FileManager.default.currentDirectoryPath)

        guard let repoRoot = candidates.first(where: { FileManager.default.fileExists(atPath: "\($0)/server/index.mjs") }) else {
            return
        }

        let nodeCandidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]
        let nodeBin = nodeCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) ?? "/usr/bin/env"

        let proc = Process()
        proc.currentDirectoryURL = URL(fileURLWithPath: repoRoot)
        if nodeBin == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", "server/index.mjs"]
        } else {
            proc.executableURL = URL(fileURLWithPath: nodeBin)
            proc.arguments = ["server/index.mjs"]
        }
        try? proc.run()
        self.bridgeProcess = proc
        Thread.sleep(forTimeInterval: 0.45)
    }

    // MARK: - Status Bar Menu

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "✦ HV"
            button.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)
        }

        let menu = NSMenu()
        let toggleItem = NSMenuItem(title: "Toggle Hermes Voice HUD (⌥Space)", action: #selector(toggleHUD), keyEquivalent: " ")
        toggleItem.keyEquivalentModifierMask = [.option]
        menu.addItem(toggleItem)

        menu.addItem(NSMenuItem(title: "Center HUD on Screen", action: #selector(centerHUD), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Open Full Workspace in Browser", action: #selector(openFullWorkspace), keyEquivalent: "o"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Check Accessibility Permission…", action: #selector(promptAccessibility), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Reload HUD", action: #selector(reloadHUD), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit Hermes Voice", action: #selector(quitApp), keyEquivalent: "q"))

        statusItem.menu = menu
    }

    // MARK: - Floating 420x680 NSPanel + WKWebView

    private func setupFloatingPanel() {
        let width: CGFloat = 420
        let height: CGFloat = 680
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let originX = screenFrame.maxX - width - 20
        let originY = screenFrame.maxY - height - 16
        let rect = NSRect(x: originX, y: originY, width: width, height: height)

        panel = HUDPanel(
            contentRect: rect,
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.backgroundColor = NSColor(calibratedRed: 0.055, green: 0.051, blue: 0.043, alpha: 0.98)
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
        webView.load(URLRequest(url: bridgeURL))
        panel.makeKeyAndOrderFront(nil)
    }

    // Grant microphone capture inside WKWebView on macOS 12+
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

    // MARK: - Global Hotkey (⌥ Space) + Graceful Accessibility Handling

    private func checkAccessibilityPermissions(prompt: Bool) {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    private func registerGlobalHotKey() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, event, userData) -> OSStatus in
                guard let userData = userData else { return noErr }
                let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async {
                    delegate.toggleHUD()
                }
                return noErr
            },
            1,
            &eventType,
            selfPtr,
            nil
        )

        // Option (optionKey = 0x0800) + Space (kVK_Space = 49)
        let hotKeyID = EventHotKeyID(signature: OSType(0x48564D43), id: 1) // 'HVMC'
        RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
    }

    // MARK: - Actions

    @objc func toggleHUD() {
        if panel.isVisible && NSApp.isActive {
            panel.orderOut(nil)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
    }

    @objc func centerHUD() {
        panel.center()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    @objc func openFullWorkspace() {
        NSWorkspace.shared.open(workspaceURL)
    }

    @objc func promptAccessibility() {
        checkAccessibilityPermissions(prompt: true)
    }

    @objc func reloadHUD() {
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
