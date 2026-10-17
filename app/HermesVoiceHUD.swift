// app/HermesVoiceHUD.swift — Native macOS Floating HUD + Menu Bar Wrapper for Hermes Voice v1.0
// Zero external dependencies. Uses Cocoa (NSPanel, NSStatusBar), WebKit (WKWebView), and Carbon (RegisterEventHotKey).
//
// Features:
//   • Auto-starts the local Node bridge (`node server/index.mjs`) on 127.0.0.1:20130 if not already running
//   • Creates a persistent macOS menu bar item ("🎙 Hermes")
//   • Opens a 420x680 borderless/HUD floating NSPanel (`level = .floating`) pinned to the top-right of the active screen
//   • Global hotkey `⌥ Space` (Option + Space) toggles the floating HUD and triggers voice listening

import Cocoa
import WebKit
import Carbon

final class FloatingHUDPanel: NSPanel {
    override var canBecomeKey: Bool { return true }
    override var canBecomeMain: Bool { return true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var statusItem: NSStatusItem!
    var panel: FloatingHUDPanel!
    var webView: WKWebView!
    var bridgeProcess: Process?
    var hotKeyRef: EventHotKeyRef?
    let bridgeURL = URL(string: "http://127.0.0.1:20130")!
    var projectRoot: String = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        resolveProjectRoot()
        ensureBridgeRunning()
        setupStatusBar()
        setupFloatingPanel()
        registerGlobalHotKey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let proc = bridgeProcess, proc.isRunning {
            proc.terminate()
        }
    }

    private func resolveProjectRoot() {
        if let envRoot = ProcessInfo.processInfo.environment["HV_PROJECT_ROOT"], !envRoot.isEmpty {
            projectRoot = envRoot
            return
        }
        if let resourcePath = Bundle.main.resourcePath {
            let rootFile = (resourcePath as NSString).appendingPathComponent("project_root.txt")
            if let saved = try? String(contentsOfFile: rootFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
               !saved.isEmpty {
                projectRoot = saved
                return
            }
        }
        projectRoot = FileManager.default.currentDirectoryPath
    }

    private func ensureBridgeRunning() {
        let healthURL = URL(string: "http://127.0.0.1:20130/api/health")!
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 1.0
        URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                DispatchQueue.main.async { self?.loadBridgeUI() }
                return
            }
            self?.spawnBridgeProcess()
        }.resume()
    }

    private func spawnBridgeProcess() {
        let serverScript = (projectRoot as NSString).appendingPathComponent("server/index.mjs")
        guard FileManager.default.fileExists(atPath: serverScript) else {
            DispatchQueue.main.async { self.loadBridgeUI() }
            return
        }
        let proc = Process()
        let nodeCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        let nodeBin = nodeCandidates.first { FileManager.default.fileExists(atPath: $0) } ?? "/usr/bin/env"
        if nodeBin == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", serverScript]
        } else {
            proc.executableURL = URL(fileURLWithPath: nodeBin)
            proc.arguments = [serverScript]
        }
        proc.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        try? proc.run()
        self.bridgeProcess = proc

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.loadBridgeUI()
        }
    }

    private func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🎙 Hermes"
            button.toolTip = "Hermes Voice v1.0 (⌥Space to toggle HUD)"
        }
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Toggle Voice HUD (⌥Space)", action: #selector(toggleHUD), keyEquivalent: " "))
        menu.addItem(NSMenuItem(title: "Expand / Compact View", action: #selector(toggleSize), keyEquivalent: "e"))
        menu.addItem(NSMenuItem(title: "Open in Default Browser", action: #selector(openInBrowser), keyEquivalent: "b"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Reload UI", action: #selector(reloadUI), keyEquivalent: "r"))
        menu.addItem(NSMenuItem(title: "Quit Hermes Voice", action: #selector(quitApp), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    private func setupFloatingPanel() {
        let screenRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width: CGFloat = 420
        let height: CGFloat = 680
        let x = screenRect.maxX - width - 20
        let y = screenRect.maxY - height - 20
        let frame = NSRect(x: x, y: y, width: width, height: height)

        panel = FloatingHUDPanel(
            contentRect: frame,
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
        panel.makeKeyAndOrderFront(nil)
    }

    private func loadBridgeUI() {
        webView.load(URLRequest(url: bridgeURL))
    }

    @objc func toggleHUD() {
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc func toggleSize() {
        guard let screen = NSScreen.main?.visibleFrame else { return }
        if panel.frame.width < 600 {
            let w: CGFloat = min(1180, screen.width - 60)
            let h: CGFloat = min(780, screen.height - 60)
            let x = screen.midX - w / 2
            let y = screen.midY - h / 2
            panel.setFrame(NSRect(x: x, y: y, width: w, height: h), display: true, animate: true)
        } else {
            let w: CGFloat = 420
            let h: CGFloat = 680
            let x = screen.maxX - w - 20
            let y = screen.maxY - h - 20
            panel.setFrame(NSRect(x: x, y: y, width: w, height: h), display: true, animate: true)
        }
    }

    @objc func openInBrowser() {
        NSWorkspace.shared.open(bridgeURL)
    }

    @objc func reloadUI() {
        webView.reload()
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }

    // Global Hotkey: Option + Space (keyCode 49 = Space, optionKey = 2048)
    private func registerGlobalHotKey() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, _, userData) -> OSStatus in
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
        let hotKeyID = EventHotKeyID(signature: OSType(0x48564D43), id: 1) // 'HVMC'
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
