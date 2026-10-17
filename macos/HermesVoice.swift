// macos/HermesVoice.swift — Native macOS Floating HUD, Audio Ducker, Status Bar & SFSpeechRecognizer Wrapper (v1.1)
//
// Zero external dependencies. Compiles with Apple's built-in `swiftc`:
//   swiftc -O macos/HermesVoice.swift -framework Cocoa -framework WebKit -framework Carbon -framework ApplicationServices -framework Speech -framework AVFoundation -o "dist/Hermes Voice.app/Contents/MacOS/HermesVoice"
//
// v1.1 Upgrades:
//   1. Native macOS Audio Ducking: Automatically ducks system/media volume when user speaks or Hermes
//      plays TTS audio, and restores original volume immediately on completion, idle, or cancel.
//   2. Global Hotkey Reliability & Status Bar Polish: Carbon `⌥ Space` registration with Accessibility
//      permission fallback warning + right-click/left-click status bar menu ("Toggle Overlay",
//      "Recent Sessions", "Open Dashboard (Browser)", "Restart Bridge", "Quit").
//   3. Offline Apple Speech (SFSpeechRecognizer) Native Hook: Pipes on-device macOS speech recognition
//      directly into the WKWebView via `hermesNative` script message handler & CustomEvents.

import Cocoa
import WebKit
import Carbon
import ApplicationServices
import Speech
import AVFoundation

final class HUDPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSMenuDelegate {
    private var panel: HUDPanel!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var statusMenu: NSMenu!
    private var recentSessionsMenu: NSMenu!
    private var accessibilityWarningItem: NSMenuItem!
    private var bridgeProcess: Process?
    private var hotKeyRef: EventHotKeyRef?
    private var localKeyMonitor: Any?

    // Audio Ducking state
    private var savedSystemVolume: Int?
    private var isAudioDucked: Bool = false

    // Native SFSpeechRecognizer state
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var sttSilenceTimer: DispatchSourceTimer?

    private let bridgeURL = URL(string: "http://127.0.0.1:20130/?hud=1")!
    private let workspaceURL = URL(string: "http://127.0.0.1:20130/")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        ensureBridgeRunning()
        setupStatusItem()
        setupFloatingPanel()
        registerGlobalHotKey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        restoreSystemVolume()
        stopNativeSTT()
        if let hotKeyRef = hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
        }
        if let monitor = localKeyMonitor {
            NSEvent.removeMonitor(monitor)
        }
        if let proc = bridgeProcess, proc.isRunning {
            proc.terminate()
        }
    }

    // MARK: - 1. Native macOS Audio Ducking

    func duckSystemVolume() {
        guard !isAudioDucked else { return }
        if let current = readSystemVolume() {
            savedSystemVolume = current
            // Duck volume to ~35% of current level (capped between 10 and 25) so background music/media doesn't interfere
            let target = min(current, max(10, Int(Double(current) * 0.35)))
            if target < current {
                setSystemVolume(target)
            }
            isAudioDucked = true
        }
    }

    func restoreSystemVolume() {
        guard isAudioDucked else { return }
        if let orig = savedSystemVolume {
            setSystemVolume(orig)
        }
        savedSystemVolume = nil
        isAudioDucked = false
    }

    private func readSystemVolume() -> Int? {
        var error: NSDictionary?
        if let script = NSAppleScript(source: "output volume of (get volume settings)") {
            let desc = script.executeAndReturnError(&error)
            if error == nil {
                return Int(desc.int32Value)
            }
        }
        return nil
    }

    private func setSystemVolume(_ volume: Int) {
        let clamped = max(0, min(100, volume))
        var error: NSDictionary?
        if let script = NSAppleScript(source: "set volume output volume \(clamped)") {
            _ = script.executeAndReturnError(&error)
        }
    }

    // MARK: - Bridge Lifecycle ("Restart Bridge" & Auto-Start)

    private func resolveRepoRoot() -> String? {
        let bundlePath = Bundle.main.bundlePath
        var candidates: [String] = []
        if let res = Bundle.main.resourcePath {
            candidates.append("\(res)/app")
        }
        candidates.append(URL(fileURLWithPath: bundlePath).deletingLastPathComponent().deletingLastPathComponent().path)
        candidates.append(FileManager.default.currentDirectoryPath)

        return candidates.first(where: { FileManager.default.fileExists(atPath: "\($0)/server/index.mjs") })
    }

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
        spawnBridgeProcess()
    }

    private func spawnBridgeProcess() {
        guard let repoRoot = resolveRepoRoot() else { return }

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

    // MARK: - 3. Status Bar Menu & Right-Click / Left-Click Polish

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "✦ HV"
            button.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .bold)
            button.toolTip = "Hermes Voice v1.1 — Press ⌥Space to toggle HUD"
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        statusMenu = NSMenu(title: "Hermes Voice")
        statusMenu.delegate = self

        let toggleItem = NSMenuItem(title: "Toggle Overlay", action: #selector(toggleHUD), keyEquivalent: " ")
        toggleItem.keyEquivalentModifierMask = [.option]
        statusMenu.addItem(toggleItem)

        let recentItem = NSMenuItem(title: "Recent Sessions", action: nil, keyEquivalent: "")
        recentSessionsMenu = NSMenu(title: "Recent Sessions")
        let emptySessionItem = NSMenuItem(title: "Loading sessions…", action: nil, keyEquivalent: "")
        emptySessionItem.isEnabled = false
        recentSessionsMenu.addItem(emptySessionItem)
        recentItem.submenu = recentSessionsMenu
        statusMenu.addItem(recentItem)

        statusMenu.addItem(NSMenuItem(title: "Open Dashboard (Browser)", action: #selector(openFullWorkspace), keyEquivalent: "o"))
        statusMenu.addItem(NSMenuItem(title: "Restart Bridge", action: #selector(restartBridge), keyEquivalent: "r"))

        statusMenu.addItem(NSMenuItem.separator())

        accessibilityWarningItem = NSMenuItem(
            title: "⚠︎ Accessibility Permission Missing (Click to Grant)…",
            action: #selector(promptAccessibility),
            keyEquivalent: ""
        )
        accessibilityWarningItem.isHidden = isAccessibilityTrusted(prompt: false)
        statusMenu.addItem(accessibilityWarningItem)

        statusMenu.addItem(NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q"))

        statusItem.menu = statusMenu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        accessibilityWarningItem.isHidden = isAccessibilityTrusted(prompt: false)
        refreshRecentSessionsSubmenu()
    }

    private func refreshRecentSessionsSubmenu() {
        guard let url = URL(string: "http://127.0.0.1:20130/api/sessions") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.2

        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard let self = self,
                  let data = data,
                  let http = resp as? HTTPURLResponse,
                  http.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sessions = json["sessions"] as? [[String: Any]] else {
                return
            }

            DispatchQueue.main.async {
                self.recentSessionsMenu.removeAllItems()
                if sessions.isEmpty {
                    let item = NSMenuItem(title: "No recent sessions", action: nil, keyEquivalent: "")
                    item.isEnabled = false
                    self.recentSessionsMenu.addItem(item)
                    return
                }

                for s in sessions.prefix(8) {
                    let id = (s["id"] as? String) ?? "session"
                    let shortId = String(id.prefix(8))
                    let status = (s["status"] as? String) ?? "active"
                    let utterances = (s["utterances"] as? [[String: Any]]) ?? []
                    let firstText = (utterances.first?["text"] as? String) ?? "Voice session"
                    let preview = firstText.count > 34 ? String(firstText.prefix(34)) + "…" : firstText
                    let title = "\(shortId) · \(preview) (\(utterances.count) turns · \(status))"
                    let item = NSMenuItem(title: title, action: #selector(self.focusSessionFromMenu(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = id
                    self.recentSessionsMenu.addItem(item)
                }
            }
        }.resume()
    }

    @objc private func focusSessionFromMenu(_ sender: NSMenuItem) {
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        if let sessionId = sender.representedObject as? String {
            let js = "window.dispatchEvent(new CustomEvent('hv:select-session', { detail: { sessionId: '\(sessionId)' } }));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // MARK: - Floating 420x680 NSPanel + WKWebView + Native Bridge

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

        let contentController = WKUserContentController()
        contentController.add(self, name: "hermesNative")

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let trusted = isAccessibilityTrusted(prompt: false)
        let js = """
        window.__HERMES_NATIVE__ = true;
        window.__HERMES_ACCESSIBILITY_TRUSTED__ = \(trusted ? "true" : "false");
        if (!\(trusted ? "true" : "false")) {
          window.dispatchEvent(new CustomEvent('hv:accessibility-warning', {
            detail: { trusted: false, message: 'Accessibility permission is recommended for global ⌥Space hotkey.' }
          }));
        }
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
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

    // Receive messages from WebView: duckAudio, restoreAudio, startNativeSTT, stopNativeSTT
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "hermesNative",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }

        switch action {
        case "duckAudio":
            duckSystemVolume()
        case "restoreAudio":
            restoreSystemVolume()
        case "startNativeSTT":
            let locale = (body["locale"] as? String) ?? "en-IN"
            startNativeSTT(localeId: locale)
        case "stopNativeSTT":
            stopNativeSTT()
        default:
            break
        }
    }

    // MARK: - 4. In-Process Offline Apple Speech (SFSpeechRecognizer) Hook

    private func startNativeSTT(localeId: String) {
        stopNativeSTT()
        duckSystemVolume()

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self = self else { return }
            guard status == .authorized else {
                self.dispatchSTTEvent(type: "error", text: "", confidence: 0, error: "SFSpeechRecognizer not authorized")
                return
            }
            DispatchQueue.main.async {
                self.beginNativeSTTSession(localeId: localeId)
            }
        }
    }

    private func beginNativeSTTSession(localeId: String) {
        let recognizer =
            SFSpeechRecognizer(locale: Locale(identifier: localeId)) ??
            SFSpeechRecognizer(locale: Locale(identifier: "en-IN")) ??
            SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

        guard let speechRecognizer = recognizer, speechRecognizer.isAvailable else {
            dispatchSTTEvent(type: "error", text: "", confidence: 0, error: "SFSpeechRecognizer unavailable")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if speechRecognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            dispatchSTTEvent(type: "error", text: "", confidence: 0, error: error.localizedDescription)
            return
        }

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                let conf = result.bestTranscription.segments.last.map { Double($0.confidence) } ?? 0.92
                if result.isFinal {
                    self.dispatchSTTEvent(type: "final", text: text, confidence: conf > 0 ? conf : 0.92, error: nil)
                    self.stopNativeSTT()
                    return
                } else if !text.isEmpty {
                    self.dispatchSTTEvent(type: "interim", text: text, confidence: conf > 0 ? conf : 0.9, error: nil)
                    self.resetSTTSilenceTimer(latestText: text, confidence: conf > 0 ? conf : 0.92)
                }
            }
            if let error = error {
                self.dispatchSTTEvent(type: "error", text: "", confidence: 0, error: error.localizedDescription)
                self.stopNativeSTT()
            }
        }
    }

    private func resetSTTSilenceTimer(latestText: String, confidence: Double) {
        sttSilenceTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .milliseconds(1800))
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            self.dispatchSTTEvent(type: "final", text: latestText, confidence: confidence, error: nil)
            self.stopNativeSTT()
        }
        timer.resume()
        sttSilenceTimer = timer
    }

    private func stopNativeSTT() {
        sttSilenceTimer?.cancel()
        sttSilenceTimer = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
    }

    private func dispatchSTTEvent(type: String, text: String, confidence: Double, error: String?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let payload: [String: Any] = [
                "type": type,
                "text": text,
                "confidence": confidence,
                "error": error ?? NSNull()
            ]
            if let data = try? JSONSerialization.data(withJSONObject: payload),
               let jsonStr = String(data: data, encoding: .utf8) {
                let js = "window.dispatchEvent(new CustomEvent('hv:native-stt', { detail: \(jsonStr) }));"
                self.webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }

    // MARK: - Global Hotkey (⌥ Space) + Graceful Accessibility Fallback

    private func isAccessibilityTrusted(prompt: Bool) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    private func registerGlobalHotKey() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

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

        // Option (optionKey = 0x0800) + Space (kVK_Space = 49)
        let hotKeyID = EventHotKeyID(signature: OSType(0x48564D43), id: 1) // 'HVMC'
        let status = RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )

        if status != noErr || !isAccessibilityTrusted(prompt: false) {
            NSLog("[HermesVoice] Accessibility permission not yet granted or Carbon hotkey status=\(status). Installing local fallback monitor.")
        }

        // Local fallback monitor when app is active
        localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.modifierFlags.contains(.option) && event.keyCode == 49 {
                self?.toggleHUD()
                return nil
            }
            return event
        }
    }

    // MARK: - Menu Actions

    @objc func toggleHUD() {
        if panel.isVisible && NSApp.isActive {
            panel.orderOut(nil)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
    }

    @objc func openFullWorkspace() {
        NSWorkspace.shared.open(workspaceURL)
    }

    @objc func restartBridge() {
        if let proc = bridgeProcess, proc.isRunning {
            proc.terminate()
            proc.waitUntilExit()
        }
        bridgeProcess = nil
        spawnBridgeProcess()
        webView.reload()
    }

    @objc func promptAccessibility() {
        _ = isAccessibilityTrusted(prompt: true)
    }

    @objc func quitApp() {
        restoreSystemVolume()
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
