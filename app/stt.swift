#!/usr/bin/env swift
// app/stt.swift — Native macOS Offline Speech-to-Text Bridge (SFSpeechRecognizer, v1.1).
//
// Pipes on-device Apple Speech recognition into Hermes Voice (via WKWebView or /api/stt/stream)
// so STT never fails if the browser webkitSpeechRecognition engine drops connection.
//
// Compile standalone binary:
//   swiftc -O app/stt.swift -framework Speech -framework AVFoundation -o dist/bin/hv-stt
// Or run directly:
//   swift app/stt.swift --locale en-IN

import Foundation
import Speech
import AVFoundation

struct STTEvent: Encodable {
    let type: String
    let text: String?
    let confidence: Double?
    let locale: String?
    let onDevice: Bool?
    let error: String?
}

func emit(_ event: STTEvent) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(event), let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    }
}

final class NativeSTTRunner {
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTimer: DispatchSourceTimer?
    private var latestText: String = ""
    private var latestConfidence: Double = 0.9
    private var finished = false
    private let localeId: String
    private let silenceMs: Int

    init(localeId: String, silenceMs: Int) {
        self.localeId = localeId
        self.silenceMs = silenceMs
    }

    func start() {
        SFSpeechRecognizer.requestAuthorization { status in
            switch status {
            case .authorized:
                DispatchQueue.main.async {
                    self.beginSession()
                }
            default:
                emit(STTEvent(
                    type: "error",
                    text: nil,
                    confidence: nil,
                    locale: self.localeId,
                    onDevice: nil,
                    error: "SFSpeechRecognizer authorization denied (\(status.rawValue))"
                ))
                exit(1)
            }
        }
    }

    private func beginSession() {
        let recognizer =
            SFSpeechRecognizer(locale: Locale(identifier: localeId)) ??
            SFSpeechRecognizer(locale: Locale(identifier: "en-IN")) ??
            SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

        guard let speechRecognizer = recognizer, speechRecognizer.isAvailable else {
            emit(STTEvent(
                type: "error",
                text: nil,
                confidence: nil,
                locale: localeId,
                onDevice: nil,
                error: "SFSpeechRecognizer not available for locale \(localeId)"
            ))
            exit(1)
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        let useOnDevice = speechRecognizer.supportsOnDeviceRecognition
        if useOnDevice {
            request.requiresOnDeviceRecognition = true
        }
        self.recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            emit(STTEvent(
                type: "error",
                text: nil,
                confidence: nil,
                locale: localeId,
                onDevice: useOnDevice,
                error: "AVAudioEngine failed to start: \(error.localizedDescription)"
            ))
            exit(1)
        }

        emit(STTEvent(
            type: "ready",
            text: nil,
            confidence: nil,
            locale: speechRecognizer.locale.identifier,
            onDevice: useOnDevice,
            error: nil
        ))

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self, !self.finished else { return }

            if let result = result {
                let transcript = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                let segments = result.bestTranscription.segments
                let conf = segments.last.map { Double($0.confidence) } ?? 0.9
                self.latestText = transcript
                self.latestConfidence = conf > 0 ? conf : 0.9

                if result.isFinal {
                    self.finishAndExit()
                    return
                } else if !transcript.isEmpty {
                    emit(STTEvent(
                        type: "interim",
                        text: transcript,
                        confidence: self.latestConfidence,
                        locale: speechRecognizer.locale.identifier,
                        onDevice: useOnDevice,
                        error: nil
                    ))
                    self.resetSilenceTimer()
                }
            }

            if let error = error {
                if !self.latestText.isEmpty {
                    self.finishAndExit()
                } else {
                    emit(STTEvent(
                        type: "error",
                        text: nil,
                        confidence: nil,
                        locale: speechRecognizer.locale.identifier,
                        onDevice: useOnDevice,
                        error: error.localizedDescription
                    ))
                    self.cleanup()
                    exit(1)
                }
            }
        }
    }

    private func resetSilenceTimer() {
        silenceTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .milliseconds(silenceMs))
        timer.setEventHandler { [weak self] in
            self?.finishAndExit()
        }
        timer.resume()
        silenceTimer = timer
    }

    func finishAndExit() {
        guard !finished else { return }
        finished = true
        emit(STTEvent(
            type: "final",
            text: latestText,
            confidence: latestConfidence,
            locale: localeId,
            onDevice: nil,
            error: nil
        ))
        cleanup()
        exit(0)
    }

    private func cleanup() {
        silenceTimer?.cancel()
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
    }
}

// Parse CLI arguments (--locale en-IN --silence-ms 1800)
var cliLocale = "en-IN"
var cliSilenceMs = 1800
let args = CommandLine.arguments
for i in 0..<args.count {
    if args[i] == "--locale", i + 1 < args.count {
        cliLocale = args[i + 1]
    }
    if args[i] == "--silence-ms", i + 1 < args.count, let ms = Int(args[i + 1]) {
        cliSilenceMs = ms
    }
}

let runner = NativeSTTRunner(localeId: cliLocale, silenceMs: cliSilenceMs)

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigIntSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigIntSrc.setEventHandler { runner.finishAndExit() }
sigIntSrc.resume()

let sigTermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigTermSrc.setEventHandler { runner.finishAndExit() }
sigTermSrc.resume()

runner.start()
RunLoop.main.run()
