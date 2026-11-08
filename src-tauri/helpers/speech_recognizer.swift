#!/usr/bin/env swift
//
// speech_recognizer.swift
// o8 — Live speech-to-text helper (daemon mode)
//
// Spawned ONCE by the Rust backend at app startup and kept alive idle
// between dictations. The parent sends commands on stdin:
//   "start" → begin a new dictation session
//   "stop"  → end current session, emit final + audio_file, return to idle
//   "quit"  → graceful exit
//
// One-shot utility modes:
//   "--permissions-json"   → print current mic/speech statuses and exit
//   "--request-permissions" → request mic/speech if needed, print statuses, exit
//
// Uses Apple's SFSpeechRecognizer for streaming partial transcripts.
// Auto-chains recognition sessions for unlimited dictation length.
// Records audio at 16kHz via AVAudioConverter for Whisper post-processing.
// SIGTERM → handleQuit() (same as "quit" command).
//

import Foundation
import Speech
import AVFoundation
import CoreAudio
import AudioToolbox

// MARK: - Globals

// `var`, not `let`: cold starts RECREATE the engine (see rebuildAudioEngine —
// a stopped engine's AUHAL resumes seconds late on Intel/Sequoia, recording
// zero frames for a whole session; a fresh engine delivers promptly).
var audioEngine = AVAudioEngine()
var recognitionTask: SFSpeechRecognitionTask?
var currentRequest: SFSpeechAudioBufferRecognitionRequest?

// Accumulated transcript across chained sessions
var accumulatedTranscript = ""
var sessionTranscript = ""

// Audio recording for Whisper — samples are already at 16kHz mono Float32
var recordedSamples: [Float] = []
var audioConverter: AVAudioConverter?
var converterSourceSampleRate: Double = 0
var converterSourceChannelCount: AVAudioChannelCount = 0

// Target format for Whisper: 16kHz mono Float32
let whisperFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: 16000,
    channels: 1,
    interleaved: false
)!

// Flag to prevent restart during shutdown of the current session
var isShuttingDown = false
// Set once the final transcript has been emitted (either via callback or safety net)
var shutdownEmitted = false
var shutdownGeneration: UInt64 = 0
/// Fences the deferred engine-stop after a session (the 15s hot linger) so a
/// new session starting inside the window cancels the pending stop.
var engineLingerGeneration: UInt64 = 0
/// Input-tap buffers delivered since daemon boot, INCLUDING gate-closed linger
/// buffers — it counts "is the AUHAL delivering" (hardware liveness), not "is a
/// session recording". The session watchdog snapshots it at gate-open to catch
/// a stalled engine (#1534). Written on the render tap thread and read on main
/// without synchronization: aligned 64-bit loads/stores are single-copy-atomic
/// on both shipping arches, and the watchdog only asks "did it move at all".
var tapBufferCount: UInt64 = 0
/// True while a config-change-observer-initiated rebuild is settling. The
/// observer ignores notifications during this window so its own rebuild's
/// notifications can't re-trigger it (rebuild storm → zero-filled session
/// head → false "microphone is silent" error).
var configChangeRebuildFenceActive = false

/// Set when a `.AVAudioEngineConfigurationChange` lands (device unplugged,
/// sample-rate change) — the prepared graph is stale; the next handleStart
/// must rebuild even if the engine still claims isRunning.
var engineNeedsRebuild = false
/// Peak |sample| seen by the tap since the current session's gate opened.
/// Distinguishes "no callbacks" (stalled engine — the watchdog rebuilds) from
/// "callbacks full of digital zeros" (the -91 dB Intel failure, #1534 — cause
/// still open; NOT TCC: the helper's Microphone right resolves Allowed on the
/// affected machine). Same benign-race caveat as tapBufferCount.
var sessionPeakSample: Float = 0
// When true, after emitting final and audio_file we exit() instead of going idle.
var isQuitting = false
// Current Rust-assigned session ID. Used to fence late callbacks.
var currentSessionId: UInt64 = 0
// Session ID currently being finalized after the live audio gate closes.
var finalizingSessionId: UInt64 = 0
// If a new start arrives while we're still finalizing the previous session,
// queue it and begin immediately after we emit the final result.
var pendingStartSessionId: UInt64?
// Active / preferred recognizer locale. Defaults to US English until the
// parent explicitly selects another locale.
var currentLocaleIdentifier = "en-US"
var pendingLocaleIdentifier: String?
var requiresOnDeviceRecognition = false
/// Flipped when Apple's SERVER recognition fails with kAFAssistantErrorDomain
/// 203 ("Retry" — observed live 2026-07-10 as 'Quota limit reached for
/// resource: speech_api, actor_type: user'): the server is refusing this
/// user and every future server request in this daemon's lifetime fails the
/// same way. When the machine supports on-device recognition, flip to it for
/// the rest of the run — no server, no quota (harness-verified on the Intel
/// machine). Re-probes the server naturally on next daemon boot.
var onDeviceFallbackActive = false
/// One actionable error per daemon lifetime when 203 hits and on-device
/// is NOT available — never a silent apple=0 again.
var quotaErrorSurfaced = false
var appleSpeechRecognitionEnabled = false
var selectedInputDeviceUID: String?
// Empty string means "switch back to system default"; nil means no pending change.
var pendingInputDeviceUID: String?
var audioTapInstalled = false

// Flush stdout after every write
setbuf(stdout, nil)

// ── Parent-death watchdog (#1539) ───────────────────────────────────────────
// stdin-EOF is the normal "parent died" signal, but it is handled by
// dispatching handleQuit to the MAIN queue — a helper whose main runloop is
// wedged (mid-AVAudioEngine call) never runs it and lives on as a zombie that
// contends for the microphone with every future helper (live incident
// 2026-07-10: pid 2329 survived two app swaps and garbled 5h of captures).
// Poll the one signal that cannot wedge: when the parent dies we are
// reparented to launchd (ppid 1) — exit directly from this thread, no queues.
Thread.detachNewThread {
    while true {
        Thread.sleep(forTimeInterval: 2.0)
        if getppid() == 1 {
            FileHandle.standardError.write(Data("[watchdog] parent died — exiting\n".utf8))
            exit(0)
        }
    }
}

// ── Main-process capture mode (#1540) ───────────────────────────────────────
// macOS 15.7.8 broke audio delivery to app-SPAWNED helpers on Intel Sequoia:
// this process's own AVAudioEngine receives silence/garbage regardless of TCC
// state, while capture in the MAIN app process still works (the composer
// path never broke). With `--audio-fifo <path>` the parent app owns the mic
// and streams 16kHz mono f32 PCM down the FIFO; this helper keeps
// SFSpeechRecognizer + the Whisper WAV, fed from the pipe. No AVAudioEngine
// is created in this mode — the entire stall/rebuild/zero-fill class is
// unreachable.
let audioFifoPath: String? = {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: "--audio-fifo"), i + 1 < args.count else { return nil }
    return args[i + 1]
}()
var audioFifoMode: Bool { audioFifoPath != nil }

// MARK: - Output helpers

/// Write a line to stdout using POSIX write() to bypass all buffering.
func rawWrite(_ s: String) {
    var str = s + "\n"
    str.withUTF8 { buf in
        _ = Darwin.write(STDOUT_FILENO, buf.baseAddress!, buf.count)
    }
}

func emit(_ type: String, _ text: String, sessionId: UInt64? = nil) {
    let escaped = text
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
    if let sessionId {
        rawWrite("{\"type\":\"\(type)\",\"text\":\"\(escaped)\",\"session_id\":\(sessionId)}")
    } else {
        rawWrite("{\"type\":\"\(type)\",\"text\":\"\(escaped)\"}")
    }
}

// MARK: level meter (begin). tests/speech-recognizer-level-meter.test.ts
// compiles this block on its own; keep it free of other helper state.

/// The waveform's microphone level: RMS in dBFS, mapped from −50…−10 dBFS
/// onto 0…1 and clamped. A linear scale left normal speech near the floor
/// and clipped loud syllables (#2534).
func meterLevel(rms: Float) -> Float {
    guard rms > 0, rms.isFinite else { return 0 }
    let dbfs = 20 * log10(rms)
    return max(0, min(1, (dbfs + 50) / 40))
}

/// Lets a level through at most once per `interval` of wall time, so the
/// rate doesn't depend on the sample rate or the buffer size.
struct LevelGate {
    var interval: TimeInterval = 0.033
    private var last: TimeInterval = -.infinity

    init(interval: TimeInterval = 0.033) {
        self.interval = interval
    }

    mutating func open(at now: TimeInterval) -> Bool {
        guard now - last >= interval else { return false }
        last = now
        return true
    }
}

// MARK: level meter (end)

func emitLevel(_ level: Float, sessionId: UInt64) {
    let clamped = max(0.0, min(1.0, level))
    rawWrite("{\"type\":\"level\",\"text\":\"\(String(format: "%.3f", clamped))\",\"session_id\":\(sessionId)}")
}

func emitError(_ msg: String, sessionId: UInt64? = nil) {
    let escaped = msg
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    if let sessionId {
        rawWrite("{\"type\":\"error\",\"text\":\"\(escaped)\",\"session_id\":\(sessionId)}")
    } else {
        rawWrite("{\"type\":\"error\",\"text\":\"\(escaped)\"}")
    }
}

func emitReady() {
    rawWrite("{\"type\":\"ready\",\"text\":\"\"}")
}

func rawWriteJSON(_ object: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: []),
        let text = String(data: data, encoding: .utf8)
    else {
        emitError("Failed to serialize helper JSON payload.")
        return
    }
    rawWrite(text)
}

func coreAudioPropertyAddress(
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

func inputDeviceHasChannels(_ deviceID: AudioDeviceID) -> Bool {
    var address = coreAudioPropertyAddress(
        selector: kAudioDevicePropertyStreamConfiguration,
        scope: kAudioDevicePropertyScopeInput
    )
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &dataSize) == noErr,
          dataSize > 0 else {
        return false
    }

    let rawBuffer = UnsafeMutableRawPointer.allocate(
        byteCount: Int(dataSize),
        alignment: MemoryLayout<AudioBufferList>.alignment
    )
    defer { rawBuffer.deallocate() }

    let bufferList = rawBuffer.bindMemory(to: AudioBufferList.self, capacity: 1)
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, bufferList) == noErr else {
        return false
    }

    let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
    let channelCount = buffers.reduce(0) { count, buffer in
        count + Int(buffer.mNumberChannels)
    }
    return channelCount > 0
}

func inputDeviceIDs() -> [AudioDeviceID] {
    var address = coreAudioPropertyAddress(selector: kAudioHardwarePropertyDevices)
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize
    ) == noErr else {
        return []
    }

    let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    guard count > 0 else { return [] }

    var devices = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize,
        &devices
    ) == noErr else {
        return []
    }

    return devices.filter(inputDeviceHasChannels)
}

func defaultInputDeviceID() -> AudioDeviceID? {
    var address = coreAudioPropertyAddress(selector: kAudioHardwarePropertyDefaultInputDevice)
    var deviceID = AudioDeviceID(kAudioObjectUnknown)
    var dataSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize,
        &deviceID
    ) == noErr, deviceID != AudioDeviceID(kAudioObjectUnknown) else {
        return nil
    }
    return deviceID
}

func stringProperty(
    deviceID: AudioDeviceID,
    selector: AudioObjectPropertySelector
) -> String? {
    var address = coreAudioPropertyAddress(selector: selector)
    var value: CFString?
    var dataSize = UInt32(MemoryLayout<CFString?>.size)
    let status = withUnsafeMutablePointer(to: &value) { valuePtr in
        AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, valuePtr)
    }
    guard status == noErr, let value else { return nil }
    return value as String
}

func audioDeviceUID(_ deviceID: AudioDeviceID) -> String? {
    stringProperty(deviceID: deviceID, selector: kAudioDevicePropertyDeviceUID)
}

func audioDeviceName(_ deviceID: AudioDeviceID) -> String? {
    stringProperty(deviceID: deviceID, selector: kAudioObjectPropertyName)
}

func inputDeviceID(forUID uid: String) -> AudioDeviceID? {
    inputDeviceIDs().first { audioDeviceUID($0) == uid }
}

func emitInputDevicesAndExit() {
    let defaultID = defaultInputDeviceID()
    let devices = inputDeviceIDs().compactMap { deviceID -> [String: Any]? in
        guard let uid = audioDeviceUID(deviceID) else { return nil }
        let name = audioDeviceName(deviceID) ?? "Microphone"
        return [
            "uid": uid,
            "name": name,
            "is_default": defaultID == deviceID,
        ]
    }
    rawWriteJSON([
        "type": "input_devices",
        "devices": devices,
    ])
    exit(0)
}

func applySelectedInputDevice(sessionId: UInt64? = nil) -> Bool {
    guard let uid = selectedInputDeviceUID, !uid.isEmpty else {
        return true
    }

    guard let deviceID = inputDeviceID(forUID: uid) else {
        // Recoverable: capture continues on the default input. An error here has
        // no session when the helper is idle, and the host tears down whichever
        // Fn dictation is starting, so a mic that moved USB ports killed it.
        emit("status", "input_device_fallback:default", sessionId: sessionId)
        selectedInputDeviceUID = nil
        return true
    }

    // If the selected mic IS the current system default, do NOT force it onto the
    // engine's input unit. Setting kAudioOutputUnitProperty_CurrentDevice to the
    // already-default device leaves the AUHAL pulling ZERO buffers — no audio
    // levels, empty transcripts — verified live on a default USB mic that worked
    // everywhere else. The engine's natural inputNode already follows the system
    // default, and that path captures fine. Only force-switch for a genuinely
    // non-default device.
    if let defaultID = defaultInputDeviceID(), defaultID == deviceID {
        return true
    }

    guard let audioUnit = audioEngine.inputNode.audioUnit else {
        emitError("Audio input unit is unavailable.", sessionId: sessionId)
        return false
    }

    // KNOWN LIMITATION — force-switching to a NON-default input device here yields
    // ZERO captured buffers (no levels, empty transcript), even though the property
    // write returns noErr. Verified standalone on the iMac built-in mic while a USB
    // mic was the system default. AVAudioEngine binds `inputNode` to the default
    // device at engine creation and caches that binding; setting
    // kAudioOutputUnitProperty_CurrentDevice on the AUHAL underneath the long-lived
    // engine doesn't propagate. DEAD END (tested, did not help): uninitialize →
    // set → reinitialize the AUHAL. A real per-app fix needs the AVAudioEngine
    // RECREATED per device switch (engine is a `let` singleton today, line 30);
    // the only other reliable route — swapping the macOS system-default input — is
    // user-hostile (hijacks every other app's mic). Deferred; the default-device
    // path (the skip-branch above) captures fine and is what users get today.
    var mutableDeviceID = deviceID
    let status = AudioUnitSetProperty(
        audioUnit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &mutableDeviceID,
        UInt32(MemoryLayout<AudioDeviceID>.size)
    )
    if status != noErr {
        emitError("Failed to switch microphone (CoreAudio \(status)).", sessionId: sessionId)
        return false
    }
    return true
}

func normalizeInputDeviceCommand(_ raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed.lowercased() == "default" || trimmed.lowercased() == "system" {
        return nil
    }
    return trimmed
}

func handleInputDeviceUpdate(_ raw: String) {
    let normalized = normalizeInputDeviceCommand(raw)
    let pendingValue = normalized ?? ""

    if audioEngine.isRunning || recognitionTask != nil || isShuttingDown {
        pendingInputDeviceUID = pendingValue
        emit("status", "input_device_pending:\(pendingValue.isEmpty ? "default" : pendingValue)")
        return
    }

    selectedInputDeviceUID = normalized
    if configureAudioInputGraph() {
        emit("status", "input_device:\(normalized ?? "default")")
    }
}

func configureRecognizer(localeIdentifier: String, sessionId: UInt64? = nil) -> Bool {
    let normalized = localeIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
        emitError("Speech recognition locale cannot be empty.", sessionId: sessionId)
        return false
    }

    guard appleSpeechRecognitionEnabled else {
        recognizer = nil
        currentLocaleIdentifier = normalized
        return true
    }

    guard let rec = SFSpeechRecognizer(locale: Locale(identifier: normalized)) else {
        emitError("SFSpeechRecognizer not available for \(normalized) locale.", sessionId: sessionId)
        return false
    }

    guard rec.isAvailable else {
        emitError("Speech recognizer is not currently available for \(normalized).", sessionId: sessionId)
        return false
    }

    if requiresOnDeviceRecognition {
        if #available(macOS 13.0, *) {
            guard rec.supportsOnDeviceRecognition else {
                emitError("On-device speech recognition is not available for \(normalized).", sessionId: sessionId)
                return false
            }
        } else {
            emitError("On-device speech recognition requires macOS 13 or newer.", sessionId: sessionId)
            return false
        }
    }

    rec.delegate = recognizerAvailabilityDelegate
    var onDevice = false
    if #available(macOS 13.0, *) {
        onDevice = rec.supportsOnDeviceRecognition
    }
    emit(
        "status",
        "recognizer_configured:\(normalized):available=\(rec.isAvailable):onDevice=\(onDevice):auth=\(SFSpeechRecognizer.authorizationStatus().rawValue)"
    )
    recognizer = rec
    currentLocaleIdentifier = normalized
    return true
}

/// Availability delegate (#1534 addendum 3): macOS flips `isAvailable` when
/// Dictation is toggled, assets download, or the network drops — flips were
/// invisible before. One global instance, re-attached on every configure.
final class RecognizerAvailabilityDelegate: NSObject, SFSpeechRecognizerDelegate {
    func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
        emit("status", "recognizer_availability_changed:\(available)")
    }
}
let recognizerAvailabilityDelegate = RecognizerAvailabilityDelegate()

func handleLocaleUpdate(_ localeIdentifier: String) {
    let normalized = localeIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
        emitError("Speech recognition locale cannot be empty.")
        return
    }

    if audioEngine.isRunning || recognitionTask != nil || isShuttingDown {
        pendingLocaleIdentifier = normalized
        return
    }

    if configureRecognizer(localeIdentifier: normalized) {
        emit("status", "locale:\(normalized)")
    }
}

func handleOnDeviceUpdate(_ enabled: Bool) {
    requiresOnDeviceRecognition = enabled
    if audioEngine.isRunning || recognitionTask != nil || isShuttingDown {
        emit("status", "on_device:\(enabled)")
        return
    }

    if configureRecognizer(localeIdentifier: currentLocaleIdentifier) {
        emit("status", "on_device:\(enabled)")
    }
}

func speechAuthorizationLabel(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized:
        return "authorized"
    case .denied:
        return "denied"
    case .restricted:
        return "restricted"
    case .notDetermined:
        return "not_determined"
    @unknown default:
        return "restricted"
    }
}

func microphoneAuthorizationLabel(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized:
        return "authorized"
    case .denied:
        return "denied"
    case .restricted:
        return "restricted"
    case .notDetermined:
        return "not_determined"
    @unknown default:
        return "restricted"
    }
}

func emitPermissionsAndExit(microphone: String, speech: String) {
    rawWrite("{\"type\":\"permissions\",\"microphone\":\"\(microphone)\",\"speech\":\"\(speech)\"}")
    exit(0)
}

func emitCurrentPermissionsAndExit() {
    emitPermissionsAndExit(
        microphone: microphoneAuthorizationLabel(AVCaptureDevice.authorizationStatus(for: .audio)),
        speech: speechAuthorizationLabel(SFSpeechRecognizer.authorizationStatus())
    )
}

func requestPermissionsAndExit() {
    func requestMicrophone(after speechStatus: String) {
        let currentMic = AVCaptureDevice.authorizationStatus(for: .audio)
        if currentMic == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                let micStatus = microphoneAuthorizationLabel(AVCaptureDevice.authorizationStatus(for: .audio))
                emitPermissionsAndExit(microphone: micStatus, speech: speechStatus)
            }
        } else {
            emitPermissionsAndExit(
                microphone: microphoneAuthorizationLabel(currentMic),
                speech: speechStatus
            )
        }
    }

    // `SFSpeechRecognizer.requestAuthorization` can hard-crash a bare dev
    // sidecar on newer macOS TCC builds even when the helper has an embedded
    // usage string. Report the current Speech status here and let the Settings
    // pane link handle manual recovery; recording still works through Whisper.
    requestMicrophone(after: speechAuthorizationLabel(SFSpeechRecognizer.authorizationStatus()))
}

// MARK: - WAV writing

/// Write recorded 16kHz mono Float32 samples as a 16-bit PCM WAV file.
func writeWavFile(sessionId: UInt64) -> String? {
    guard !recordedSamples.isEmpty else { return nil }

    let tempDir = NSTemporaryDirectory()
    let wavPath = (tempDir as NSString)
        .appendingPathComponent("o8_dictation_\(sessionId)_\(UUID().uuidString).wav")

    let numSamples = UInt32(recordedSamples.count)
    let sampleRate: UInt32 = 16000
    let bitsPerSample: UInt16 = 16
    let numChannels: UInt16 = 1
    let byteRate = sampleRate * UInt32(numChannels) * UInt32(bitsPerSample / 8)
    let blockAlign = numChannels * (bitsPerSample / 8)
    let dataSize = numSamples * UInt32(bitsPerSample / 8)
    let fileSize = 36 + dataSize

    var data = Data()
    data.reserveCapacity(Int(44 + dataSize))

    data.append(contentsOf: "RIFF".utf8)
    data.append(contentsOf: withUnsafeBytes(of: fileSize.littleEndian) { Array($0) })
    data.append(contentsOf: "WAVE".utf8)
    data.append(contentsOf: "fmt ".utf8)
    data.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: numChannels.littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: sampleRate.littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: byteRate.littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: blockAlign.littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: bitsPerSample.littleEndian) { Array($0) })
    data.append(contentsOf: "data".utf8)
    data.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })

    var pcmSamples = [Int16]()
    pcmSamples.reserveCapacity(recordedSamples.count)
    for sample in recordedSamples {
        let clamped = max(-1.0, min(1.0, sample))
        pcmSamples.append(Int16(clamped * 32767).littleEndian)
    }
    pcmSamples.withUnsafeBytes { rawBuffer in
        data.append(rawBuffer.bindMemory(to: UInt8.self))
    }

    do {
        try data.write(to: URL(fileURLWithPath: wavPath))
        return wavPath
    } catch {
        emitError("Failed to write audio file: \(error.localizedDescription)")
        return nil
    }
}

// MARK: - Session lifecycle

/// End the current dictation session. Does NOT exit and does NOT stop the
/// audio engine — the mic stays hot for the next session so the following
/// Fn press doesn't pay cold-start latency. `currentSessionId = 0` is the
/// gate that makes the live tap discard all subsequent buffers until
/// handleStart opens it again.
func stopSession(requestedSessionId: UInt64? = nil) {
    guard !isShuttingDown else { return }
    if let requestedSessionId, requestedSessionId != currentSessionId {
        return
    }
    isShuttingDown = true
    shutdownGeneration &+= 1
    finalizingSessionId = currentSessionId
    let shutdownSessionId = finalizingSessionId
    let shutdownGenerationAtStop = shutdownGeneration

    // Close the gate — new buffers from the still-running tap now hit the
    // early-return and go nowhere. The last few buffers that arrive before
    // finish() processes have already been appended to currentRequest and
    // will show up in the final result.
    currentSessionId = 0

    // Ask for the final result. The callback on the main queue will fire
    // with isFinal=true (or an error). We emit the full transcript from
    // THERE, not here — otherwise we lose the tail of the current session.
    if let recognitionTask {
        recognitionTask.finish()
    } else if finishAnalyzerSessionIfActive() {
        // SpeechAnalyzer owns this session — its results loop delivers the
        // final into sessionTranscript and calls emitFinalAndReturnToIdle.
        // The 1.5s safety net below still covers a wedged finalize.
    } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            if isShuttingDown
                && !shutdownEmitted
                && finalizingSessionId == shutdownSessionId
                && shutdownGeneration == shutdownGenerationAtStop {
                emitFinalAndReturnToIdle()
            }
        }
    }

    // Safety net: if no callback fires within 1.5s, emit what we have and idle.
    // Rapid Fn double-tap can cancel this shutdown and start a fresh session
    // before the timer fires; fence the timer so it cannot finalize the new
    // long-form dictation.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        if isShuttingDown
            && !shutdownEmitted
            && finalizingSessionId == shutdownSessionId
            && shutdownGeneration == shutdownGenerationAtStop {
            emitFinalAndReturnToIdle()
        }
    }
}

/// Emit the final transcript + audio file, then return to idle state
/// (or exit if isQuitting is set).
func emitFinalAndReturnToIdle() {
    guard !shutdownEmitted else { return }
    shutdownEmitted = true
    let sessionId = finalizingSessionId != 0 ? finalizingSessionId : currentSessionId

    let fullTranscript: String
    if !sessionTranscript.isEmpty {
        fullTranscript = accumulatedTranscript.isEmpty
            ? sessionTranscript
            : accumulatedTranscript + " " + sessionTranscript
    } else {
        fullTranscript = accumulatedTranscript
    }
    if !fullTranscript.isEmpty {
        emit("final", fullTranscript, sessionId: sessionId)
    }
    if let wavPath = writeWavFile(sessionId: sessionId) {
        emit("audio_file", wavPath, sessionId: sessionId)
    }
    emit("complete", "", sessionId: sessionId)
    finalizingSessionId = 0
    if isQuitting {
        exit(0)
    }
    let pendingStart = pendingStartSessionId
    pendingStartSessionId = nil

    // Turn the mic off between sessions — but LINGER hot for a short window
    // first (2026-07-08: consecutive dictations were each paying the engine
    // cold start — 30-80ms built-in, 300-800ms on Bluetooth — eating the first
    // spoken words; the operator's real cadence is press → answer → press
    // again within seconds). The gate is CLOSED (currentSessionId == 0), so
    // buffers during the linger are discarded at the top of the tap; the
    // orange mic dot staying on ~15s after a dictation is the honest signal
    // that the hardware is still warm. A mic-device change still stops
    // immediately (the input graph must be rebuilt anyway).
    if pendingInputDeviceUID != nil {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
    } else if pendingStart == nil && audioEngine.isRunning {
        engineLingerGeneration &+= 1
        let lingerGeneration = engineLingerGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 15.0) {
            if engineLingerGeneration == lingerGeneration
                && currentSessionId == 0
                && !isShuttingDown
                && audioEngine.isRunning {
                audioEngine.stop()
            }
        }
    }

    // Reset session state and return to idle.
    resetSessionState()
    if let pendingInputDevice = pendingInputDeviceUID {
        pendingInputDeviceUID = nil
        selectedInputDeviceUID = pendingInputDevice.isEmpty ? nil : pendingInputDevice
        _ = configureAudioInputGraph(sessionId: sessionId)
    }
    if let pendingLocale = pendingLocaleIdentifier {
        pendingLocaleIdentifier = nil
        _ = configureRecognizer(localeIdentifier: pendingLocale, sessionId: sessionId)
    }
    if let pendingStart {
        handleStart(sessionId: pendingStart)
    } else {
        emitReady()
    }
}

/// Reset all per-session state. Called before starting a new session AND
/// after cleanly ending one.
func resetSessionState() {
    sessionTranscript = ""
    accumulatedTranscript = ""
    isShuttingDown = false
    shutdownEmitted = false
    recordedSamples.removeAll(keepingCapacity: true)
    recognitionTask = nil
    currentRequest = nil
    cancelAnalyzerSessionIfActive()
    currentSessionId = 0
}

// MARK: - Signal handling

func handleQuit() {
    // If a session is active, stop it first — the final callback will see
    // isQuitting and exit(0) after emitting.
    if (recognitionTask != nil || analyzerBox != nil) && audioEngine.isRunning {
        isQuitting = true
        stopSession()
        return
    }
    // No session active — exit immediately.
    exit(0)
}

let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
sigTermSource.setEventHandler { handleQuit() }
sigTermSource.resume()

let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
signal(SIGINT, SIG_IGN)
sigIntSource.setEventHandler { handleQuit() }
sigIntSource.resume()

// MARK: - Authorization

func requestAuthorization(completion: @escaping (Bool) -> Void) {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized:
        appleSpeechRecognitionEnabled = true
        completion(true)
    case .denied:
        appleSpeechRecognitionEnabled = false
        emit("status", "speech_recognition:denied")
        completion(true)
    case .restricted:
        appleSpeechRecognitionEnabled = false
        emit("status", "speech_recognition:restricted")
        completion(true)
    case .notDetermined:
        // Brand-new app identity (o8 has NEVER been granted, unlike the legacy
        // Symon bundle whose status is already .authorized): actually PROMPT for
        // Speech Recognition. The prior report-only branch left a fresh install
        // permanently notDetermined → appleSpeechRecognitionEnabled stayed false →
        // startRecognitionSession early-returned → EMPTY transcripts (apple=0).
        // This is SAFE to call here: the helper embeds NSSpeechRecognitionUsage-
        // Description in its OWN __info_plist section (build.rs -sectcreate) and
        // runs a main run loop, so the standard Apple API neither crashes (the
        // "bare dev sidecar" crash needed a missing usage string) nor no-ops.
        emit("status", "speech_recognition:requesting")
        SFSpeechRecognizer.requestAuthorization { newStatus in
            DispatchQueue.main.async {
                switch newStatus {
                case .authorized:
                    appleSpeechRecognitionEnabled = true
                    emit("status", "speech_recognition:authorized")
                case .denied:
                    emit("status", "speech_recognition:denied")
                default:
                    emit("status", "speech_recognition:restricted")
                }
                // Proceed regardless — even with speech denied the audio engine
                // still records the WAV for the Whisper finalize fallback path.
                completion(true)
            }
        }
    @unknown default:
        appleSpeechRecognitionEnabled = false
        emit("status", "speech_recognition:restricted")
        completion(true)
    }
}

// MARK: - SpeechAnalyzer path (macOS 26+)

// The durable replacement for SFSpeechRecognizer's fragile server path
// (2026-07-13 Apple Silicon diagnosis, vault/memory: waveform-moves-zero-
// partials on M4). SpeechTranscriber is fully on-device, needs NO
// Siri/Dictation toggle (kills kLSRErrorDomain 201 structurally), no speech-
// recognition TCC grant, and its model asset is APP-downloadable via
// AssetInventory — SFSpeech could only tell the user to visit System
// Settings. Fail-safe contract: any failure anywhere in this path latches
// `analyzerUnusableForRun` and the session falls back to the untouched
// SFSpeechRecognizer machinery below; macOS ≤ 15 never enters it.

/// Opt-out escape hatch for the field: O8_DISABLE_SPEECH_ANALYZER=1.
var analyzerDisabledByEnv = ProcessInfo.processInfo.environment["O8_DISABLE_SPEECH_ANALYZER"] == "1"
/// Latched true on the first analyzer failure — SFSpeech owns the rest of the run.
var analyzerUnusableForRun = false
/// Latch so the background model download is only kicked once per run.
var analyzerAssetDownloadStarted = false
/// The live analyzer session (typed AnyObject so pre-26 targets still compile).
var analyzerBox: AnyObject?
/// True between the gate taking ownership and the async setup resolving.
/// While set, the tap parks buffers in `analyzerPendingBuffers` so the first
/// spoken words survive the ~100ms analyzer boot (classic first-words-cut
/// dictation bug) and are flushed into whichever engine wins.
var analyzerStarting = false
var analyzerPendingBuffers: [AVAudioPCMBuffer] = []
let analyzerPendingLock = NSLock()

func analyzerParkBuffer(_ buffer: AVAudioPCMBuffer) {
    analyzerPendingLock.lock()
    if analyzerPendingBuffers.count < 64 { // ~1.5s cap — never grow unbounded
        analyzerPendingBuffers.append(buffer)
    }
    analyzerPendingLock.unlock()
}

func analyzerTakePendingBuffers() -> [AVAudioPCMBuffer] {
    analyzerPendingLock.lock()
    let pending = analyzerPendingBuffers
    analyzerPendingBuffers = []
    analyzerPendingLock.unlock()
    return pending
}

@available(macOS 26.0, *)
final class AnalyzerSession {
    let sessionId: UInt64
    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    private let inputContinuation: AsyncStream<AnalyzerInput>.Continuation
    private let analyzerFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    /// Text already finalized by the transcriber this session; volatile
    /// results are appended on top of it for each partial emission.
    private var finalizedText = ""
    private var resultsTask: Task<Void, Never>?
    private var finishing = false

    private init(
        sessionId: UInt64,
        transcriber: SpeechTranscriber,
        analyzer: SpeechAnalyzer,
        inputContinuation: AsyncStream<AnalyzerInput>.Continuation,
        analyzerFormat: AVAudioFormat?
    ) {
        self.sessionId = sessionId
        self.transcriber = transcriber
        self.analyzer = analyzer
        self.inputContinuation = inputContinuation
        self.analyzerFormat = analyzerFormat
    }

    /// Build and start a session for the current locale, or return nil when
    /// the analyzer path cannot own this session (unsupported locale, asset
    /// not yet installed, or any setup error). Asset-missing is NOT a
    /// failure: the download is kicked off in the background and the
    /// analyzer takes over on a later session once it lands.
    static func make(sessionId: UInt64, localeIdentifier: String) async -> AnalyzerSession? {
        let locale = Locale(identifier: localeIdentifier)
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )

        do {
            let installed = await SpeechTranscriber.installedLocales
            let isInstalled = installed.contains {
                $0.identifier(.bcp47) == locale.identifier(.bcp47)
            }
            if !isInstalled {
                let supported = await SpeechTranscriber.supportedLocales
                if supported.isEmpty {
                    // Hardware without on-device transcription at all (live-
                    // verified: Intel macOS 26 reports zero locales). Latch
                    // the path off so future sessions skip the probe and go
                    // straight to SFSpeech with no added start latency.
                    analyzerUnusableForRun = true
                    emit("status", "analyzer_unsupported_hardware", sessionId: sessionId)
                    return nil
                }
                let isSupported = supported.contains {
                    $0.identifier(.bcp47) == locale.identifier(.bcp47)
                }
                guard isSupported else {
                    emit("status", "analyzer_locale_unsupported:\(localeIdentifier)", sessionId: sessionId)
                    return nil
                }
                if !analyzerAssetDownloadStarted {
                    analyzerAssetDownloadStarted = true
                    emit("status", "analyzer_asset_downloading:\(localeIdentifier)", sessionId: sessionId)
                    Task.detached {
                        do {
                            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                                try await request.downloadAndInstall()
                            }
                            emit("status", "analyzer_asset_installed:\(localeIdentifier)")
                        } catch {
                            emit("status", "analyzer_asset_download_failed:\(error.localizedDescription)")
                        }
                    }
                }
                // SFSpeech carries this session; the analyzer owns the next
                // one that starts after the download completes.
                return nil
            }

            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
            let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
            let session = AnalyzerSession(
                sessionId: sessionId,
                transcriber: transcriber,
                analyzer: analyzer,
                inputContinuation: continuation,
                analyzerFormat: format
            )
            session.startResultsLoop()
            try await analyzer.start(inputSequence: stream)
            return session
        } catch {
            emit("status", "analyzer_setup_failed:\(error.localizedDescription)", sessionId: sessionId)
            return nil
        }
    }

    /// Consume transcriber results and mirror them into the exact state the
    /// legacy path uses (`sessionTranscript` + partial emissions), so
    /// emitFinalAndReturnToIdle / Whisper finalize work unchanged. Volatile
    /// results REPLACE the pending tail; finalized results fold into
    /// `finalizedText`.
    private func startResultsLoop() {
        resultsTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await result in self.transcriber.results {
                    let text = String(result.text.characters)
                    DispatchQueue.main.async {
                        guard self.sessionId == currentSessionId
                            || (isShuttingDown && self.sessionId == finalizingSessionId) else { return }
                        if result.isFinal {
                            self.finalizedText = self.finalizedText.isEmpty
                                ? text
                                : self.finalizedText + " " + text
                            sessionTranscript = self.finalizedText
                        } else if text.isEmpty {
                            sessionTranscript = self.finalizedText
                        } else {
                            sessionTranscript = self.finalizedText.isEmpty
                                ? text
                                : self.finalizedText + " " + text
                        }
                        let fullText = accumulatedTranscript.isEmpty
                            ? sessionTranscript
                            : accumulatedTranscript + " " + sessionTranscript
                        if !fullText.isEmpty {
                            emit("partial", fullText, sessionId: self.sessionId)
                        }
                    }
                }
            } catch {
                emit("status", "analyzer_results_error:\(error.localizedDescription)", sessionId: self.sessionId)
            }
            // Results stream ended (finalize or failure) — if we are the
            // session being shut down, deliver the final from the same
            // machinery the legacy path uses.
            DispatchQueue.main.async {
                if isShuttingDown && self.sessionId == finalizingSessionId {
                    emitFinalAndReturnToIdle()
                }
            }
        }
    }

    /// Called from the audio tap thread with the raw mic buffer.
    func append(_ buffer: AVAudioPCMBuffer) {
        guard !finishing else { return }
        guard let analyzerFormat else {
            inputContinuation.yield(AnalyzerInput(buffer: buffer))
            return
        }
        if buffer.format == analyzerFormat {
            inputContinuation.yield(AnalyzerInput(buffer: buffer))
            return
        }
        if converter == nil || converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: analyzerFormat)
        }
        guard let converter else { return }
        let ratio = analyzerFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio))
        guard capacity > 0,
              let out = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var conversionError: NSError?
        converter.convert(to: out, error: &conversionError) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        if conversionError == nil, out.frameLength > 0 {
            inputContinuation.yield(AnalyzerInput(buffer: out))
        }
    }

    /// Ask the analyzer for its final result. The results loop delivers it
    /// into sessionTranscript and then calls emitFinalAndReturnToIdle; the
    /// existing 1.5s stopSession safety net still covers a wedged finalize.
    func finish() {
        guard !finishing else { return }
        finishing = true
        inputContinuation.finish()
        Task {
            do {
                try await analyzer.finalizeAndFinishThroughEndOfInput()
            } catch {
                emit("status", "analyzer_finalize_error:\(error.localizedDescription)", sessionId: sessionId)
                DispatchQueue.main.async {
                    if isShuttingDown && self.sessionId == finalizingSessionId {
                        emitFinalAndReturnToIdle()
                    }
                }
            }
        }
    }

    func cancel() {
        finishing = true
        inputContinuation.finish()
        resultsTask?.cancel()
        Task { await analyzer.cancelAndFinishNow() }
    }
}

/// Gate at the top of startRecognitionSession: returns true when the
/// analyzer path takes ownership of this session. Async setup — on failure
/// it latches analyzer-off and re-enters startRecognitionSession, which then
/// routes to SFSpeech.
func startAnalyzerSessionIfPossible(sessionId: UInt64) -> Bool {
    guard #available(macOS 26.0, *), !analyzerDisabledByEnv, !analyzerUnusableForRun else {
        return false
    }
    let localeId = currentLocaleIdentifier
    analyzerStarting = true
    Task {
        let session = await AnalyzerSession.make(sessionId: sessionId, localeIdentifier: localeId)
        DispatchQueue.main.async {
            guard sessionId == currentSessionId, !isShuttingDown else {
                analyzerStarting = false
                _ = analyzerTakePendingBuffers()
                if #available(macOS 26.0, *), let s = session { s.cancel() }
                return
            }
            if let session {
                analyzerBox = session
                sessionTranscript = ""
                analyzerStarting = false
                for parked in analyzerTakePendingBuffers() {
                    session.append(parked)
                }
                emit("status", "analyzer_session_started:\(localeId)", sessionId: sessionId)
            } else {
                // Not usable (this session) — SFSpeech carries it. Only
                // hardware-unsupported latches the whole run off; locale and
                // asset misses retry naturally next session.
                startSFSpeechRecognitionSession(sessionId: sessionId)
                analyzerStarting = false
                for parked in analyzerTakePendingBuffers() {
                    currentRequest?.append(parked)
                }
            }
        }
    }
    return true
}

/// Route the live tap buffer to whichever engine owns the session.
func feedRecognitionAudio(_ buffer: AVAudioPCMBuffer) {
    if #available(macOS 26.0, *), let session = analyzerBox as? AnalyzerSession {
        session.append(buffer)
        return
    }
    if analyzerStarting {
        analyzerParkBuffer(buffer)
        return
    }
    currentRequest?.append(buffer)
}

/// Finish the analyzer session if one owns the current shutdown; returns
/// true when the analyzer will deliver the final (so stopSession should not
/// double-finalize through the legacy path).
func finishAnalyzerSessionIfActive() -> Bool {
    guard #available(macOS 26.0, *), let session = analyzerBox as? AnalyzerSession else {
        return false
    }
    analyzerBox = nil
    session.finish()
    return true
}

/// Hard-cancel (rapid restart / teardown) — no final expected.
func cancelAnalyzerSessionIfActive() {
    guard #available(macOS 26.0, *), let session = analyzerBox as? AnalyzerSession else { return }
    analyzerBox = nil
    session.cancel()
}

// MARK: - Recognition (restartable)

var recognizer: SFSpeechRecognizer?
var inputNode: AVAudioInputNode!
var nativeFormat: AVAudioFormat!

/// Start or restart a recognition session. The audio engine stays running;
/// only the recognition engine state is recreated. On macOS 26+ the
/// SpeechAnalyzer path takes the session when usable; everything else (and
/// every chained SFSpeech restart) rides the legacy path below.
func startRecognitionSession(sessionId: UInt64) {
    guard !isShuttingDown else { return }
    if startAnalyzerSessionIfPossible(sessionId: sessionId) { return }
    startSFSpeechRecognitionSession(sessionId: sessionId)
}

/// The legacy SFSpeechRecognizer session (macOS ≤ 15, analyzer fallback, and
/// mid-session chain restarts — a session never switches engines midway).
func startSFSpeechRecognitionSession(sessionId: UInt64) {
    guard !isShuttingDown else { return }
    guard appleSpeechRecognitionEnabled else {
        // This early-return IS the "apple=0 on every session" signature: speech
        // auth resolved denied/restricted/never-asked at boot and every session
        // silently skips Apple recognition. Say so — Whisper can mask it on
        // keyed installs, but a keyless free install has NOTHING behind it
        // (#1534 addendum 3: recognizer failures must never be silent).
        emit("status", "recognizer_skipped:speech_auth_disabled", sessionId: sessionId)
        currentRequest = nil
        recognitionTask = nil
        sessionTranscript = ""
        return
    }
    guard let recognizer = recognizer, recognizer.isAvailable else {
        emit(
            "status",
            "recognizer_unavailable:\(recognizer == nil ? "nil" : "isAvailable=false"):\(currentLocaleIdentifier)",
            sessionId: sessionId
        )
        emitError("Speech recognizer not available for restart.", sessionId: sessionId)
        return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true

    if #available(macOS 13.0, *) {
        request.requiresOnDeviceRecognition = requiresOnDeviceRecognition || onDeviceFallbackActive
        request.addsPunctuation = true
    }

    currentRequest = request
    sessionTranscript = ""

    recognitionTask = recognizer.recognitionTask(with: request) { result, error in
        let isCurrentSession = sessionId == currentSessionId
        let isFinalizingSession = isShuttingDown && sessionId == finalizingSessionId
        guard isCurrentSession || isFinalizingSession else { return }

        if let result = result {
            let text = result.bestTranscription.formattedString
            sessionTranscript = text

            // Emit the full accumulated transcript + current session
            let fullText = accumulatedTranscript.isEmpty
                ? text
                : accumulatedTranscript + " " + text

            if result.isFinal {
                // Session ended (hit ~60s limit OR we asked finish()).
                accumulatedTranscript = fullText
                if isShuttingDown {
                    // This final is the result of our finish() during shutdown.
                    // fullText (and thus accumulatedTranscript) already includes
                    // this session's text — clear sessionTranscript so the
                    // emit path doesn't concatenate the tail twice.
                    sessionTranscript = ""
                    emitFinalAndReturnToIdle()
                    return
                }
                emit("partial", fullText, sessionId: sessionId)
                // Chain to next session — no delay to minimize audio gap.
                DispatchQueue.main.async {
                    startSFSpeechRecognitionSession(sessionId: sessionId)
                }
            } else {
                emit("partial", fullText, sessionId: sessionId)
            }
        }

        if let error = error as NSError? {
            // NEVER swallow recognizer errors (#1534 addendum 3) — this
            // callback was the only witness to "SFSpeechRecognizer returns
            // nothing from real audio" and it said nothing. 216 = canceled
            // (our own teardown), 1110 = no speech detected; everything else
            // is a real failure worth reading in the field log.
            emit(
                "status",
                "recognizer_error:\(error.domain):\(error.code):\(error.localizedDescription)",
                sessionId: sessionId
            )
            // Server path dead — flip to on-device for the rest of this
            // daemon's lifetime when the machine supports it; the chained
            // restart below picks the flag up immediately. Two triggers:
            //   203 (kAFAssistantErrorDomain) = server refused (observed
            //   live: speech_api user quota).
            //   201 (kLSRErrorDomain) = "Siri and Dictation are disabled" —
            //   since macOS ~14 the SERVER path requires Siri or Keyboard
            //   Dictation enabled in System Settings while isAvailable still
            //   lies true (FB13235751). A fresh Mac with Dictation never
            //   toggled hits this on EVERY task; before 2026-07-13 it just
            //   chain-restarted forever — the Apple Silicon "waveform moves,
            //   zero partials" bug. A transient server hiccup costs nothing
            //   (on-device transcribes fine); a real lockout costs EVERYTHING
            //   without this. If on-device is unavailable, say so once,
            //   actionably — never a silent apple=0 again.
            let serverPathDead =
                (error.domain == "kAFAssistantErrorDomain" && error.code == 203)
                || (error.domain == "kLSRErrorDomain" && error.code == 201)
            if serverPathDead && !onDeviceFallbackActive {
                var onDeviceSupported = false
                if #available(macOS 13.0, *) {
                    onDeviceSupported = recognizer.supportsOnDeviceRecognition
                }
                if onDeviceSupported {
                    onDeviceFallbackActive = true
                    emit(
                        "status",
                        "recognizer_fallback:on_device_after_\(error.domain == "kLSRErrorDomain" ? "201" : "203")",
                        sessionId: sessionId
                    )
                } else if !quotaErrorSurfaced {
                    quotaErrorSurfaced = true
                    emitError(
                        error.code == 201
                            ? "Apple requires Siri or Dictation to be enabled for speech recognition. Turn on Dictation in System Settings → Keyboard, then relaunch o8."
                            : "Apple's speech service is rate-limiting this Mac and offline dictation isn't installed. Enable Dictation in System Settings → Keyboard to download offline speech, then relaunch o8.",
                        sessionId: sessionId
                    )
                }
            }
            // 1101 (kAFAssistantErrorDomain) = the ON-DEVICE model asset is
            // missing ("No asset found com.apple.siri.asr.assistant"). Fires
            // when the on-device path runs on a Mac that never downloaded the
            // offline speech model (it only installs when a Dictation language
            // is added). Chain-restarting cannot fix an absent asset — surface
            // the actionable step once instead of dying silently.
            if error.domain == "kAFAssistantErrorDomain" && error.code == 1101
                && (onDeviceFallbackActive || requiresOnDeviceRecognition)
                && !quotaErrorSurfaced {
                quotaErrorSurfaced = true
                emitError(
                    "Offline dictation isn't installed on this Mac. Enable Dictation in System Settings → Keyboard to download offline speech, then relaunch o8.",
                    sessionId: sessionId
                )
            }
            if isShuttingDown {
                // finish() delivered an error instead of a final — still emit
                // whatever we have accumulated and idle.
                emitFinalAndReturnToIdle()
                return
            }
            if error.code != 216 {
                // Recognition timed out or errored — chain to next session.
                // 1110 ("no speech detected") INCLUDED (2026-07-13): a natural
                // pause in a long dictation ends the segment with 1110, and the
                // old `!= 1110` guard killed the chain permanently — partials
                // stopped ~1 min in and everything spoken after the pause was
                // lost from the live pass (the 3-4 min trading-journal loss).
                // A silent hold just cycles 1110 → fresh task, which is cheap
                // and correct for push-to-talk. Only 216 (our own cancel) is
                // terminal.
                //
                // Fold this segment's partial text into the accumulator BEFORE
                // chaining — an errored task never delivers isFinal, and the
                // fresh session's reset would otherwise wipe the words Apple
                // already heard.
                if !sessionTranscript.isEmpty {
                    accumulatedTranscript = accumulatedTranscript.isEmpty
                        ? sessionTranscript
                        : accumulatedTranscript + " " + sessionTranscript
                    sessionTranscript = ""
                }
                DispatchQueue.main.async {
                    startSFSpeechRecognitionSession(sessionId: sessionId)
                }
            }
        }
    }
}

// MARK: - Audio engine setup (once at startup)

/// Tear down and RECREATE the AVAudioEngine, then rebuild the input graph on
/// the fresh instance.
///
/// Why recreation instead of reusing the stopped singleton: on Intel /
/// macOS 15.7 an engine that has been stop()ped and start()ed again reports
/// isRunning=true but its AUHAL delivers no input buffers for many SECONDS
/// (worse when the parent app is simultaneously touching the shared built-in
/// audio hardware for the dictation sound cue / audio ducker). Every
/// dictation shorter than that stall records ZERO frames and finalizes
/// empty — the Intel "dictation never delivers" bug (#1534): the paste seam
/// was fine, capture was dead. A freshly created engine binds a fresh AUHAL
/// and delivers promptly — which is exactly why the FIRST dictation after
/// daemon boot always captured. This is also the engine-recreation fix the
/// applySelectedInputDevice KNOWN LIMITATION comment calls for.
///
/// Safe mid-session: the new tap keeps appending into `currentRequest` /
/// `recordedSamples` (all globals), so an in-flight recognition session
/// continues across the swap.
func rebuildAudioEngine(sessionId: UInt64? = nil) -> Bool {
    if audioEngine.isRunning {
        audioEngine.stop()
    }
    if audioTapInstalled {
        inputNode.removeTap(onBus: 0)
        audioTapInstalled = false
    }
    audioEngine = AVAudioEngine()
    engineNeedsRebuild = false
    return configureAudioInputGraph(sessionId: sessionId)
}

/// Rebuild the input graph for the selected microphone. The engine must be
/// stopped before this runs.
func configureAudioInputGraph(sessionId: UInt64? = nil) -> Bool {
    if audioEngine.isRunning {
        audioEngine.stop()
    }
    if audioTapInstalled {
        inputNode.removeTap(onBus: 0)
        audioTapInstalled = false
    }

    inputNode = audioEngine.inputNode

    guard applySelectedInputDevice(sessionId: sessionId) else {
        return false
    }

    nativeFormat = inputNode.outputFormat(forBus: 0)

    guard nativeFormat.sampleRate > 0 else {
        emitError("No audio input available. Check microphone permissions.", sessionId: sessionId)
        return false
    }

    audioConverter = nil
    converterSourceSampleRate = 0
    converterSourceChannelCount = 0

    // Pre-allocate for ~5 minutes of 16kHz audio
    recordedSamples.reserveCapacity(16000 * 300)

    // Prepare the engine (negotiates hardware format, allocates buffers)
    audioEngine.prepare()

    // Install the tap ONCE so the format + buffer processing callback is
    // ready to go the moment we start the engine. The engine itself is NOT
    // started here — that would light the macOS "mic in use" orange dot
    // for the app's entire lifetime, which is what Intel users were
    // (correctly) calling out as invasive. Instead, handleStart kicks the
    // engine on, stopSession kicks it off. Cold-start latency for
    // AVAudioEngine.start() is ~30–80ms on modern macOS — well under the
    // user's natural press-to-speak gap.
    var frameCount = 0
    var levelGate = LevelGate()
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in
        // Liveness signal for the zero-buffer watchdog — count EVERY callback,
        // gate open or closed (see tapBufferCount doc).
        tapBufferCount &+= 1

        // Pre-session idle: mic is hot but we're not recording.
        // Drop every buffer until handleStart flips the gate.
        if currentSessionId == 0 {
            return
        }

        // Feed audio to whichever recognition engine owns the session
        feedRecognitionAudio(buffer)

        // Convert to 16kHz mono for Whisper recording. Build the converter
        // from the actual buffer format so external mics with different
        // hardware formats do not invalidate the tap.
        let sourceFormat = buffer.format
        let sourceRate = sourceFormat.sampleRate
        guard sourceRate > 0 else { return }
        if audioConverter == nil ||
            converterSourceSampleRate != sourceRate ||
            converterSourceChannelCount != sourceFormat.channelCount {
            audioConverter = AVAudioConverter(from: sourceFormat, to: whisperFormat)
            converterSourceSampleRate = sourceRate
            converterSourceChannelCount = sourceFormat.channelCount
        }
        guard let converter = audioConverter else { return }
        let ratio = 16000.0 / sourceRate
        let outputFrameCapacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio))
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: whisperFormat, frameCapacity: outputFrameCapacity) else {
            return
        }

        var conversionError: NSError?
        var inputConsumed = false
        converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
            if inputConsumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            inputConsumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        if conversionError == nil, let channelData = outputBuffer.floatChannelData {
            let frames = Int(outputBuffer.frameLength)
            if frames > 0 {
                recordedSamples.append(contentsOf: UnsafeBufferPointer(start: channelData[0], count: frames))
            }
        }

        // The peak keeps its every-6-buffers sampling; the level is sent at
        // most every ~33ms of wall time.
        frameCount += 1
        let peakDue = frameCount % 6 == 0
        let levelDue = levelGate.open(at: ProcessInfo.processInfo.systemUptime)
        if peakDue || levelDue {
            guard let channelData = buffer.floatChannelData else { return }
            let frames = buffer.frameLength
            let samples = channelData[0]
            var sumOfSquares: Float = 0
            var peak: Float = 0
            for i in 0..<Int(frames) {
                let sample = samples[i]
                sumOfSquares += sample * sample
                peak = max(peak, abs(sample))
            }
            if peakDue && peak > sessionPeakSample {
                sessionPeakSample = peak
            }
            if levelDue {
                let rms = sqrt(sumOfSquares / Float(frames))
                emitLevel(meterLevel(rms: rms), sessionId: currentSessionId)
            }
        }
    }
    audioTapInstalled = true

    // Engine stays off until the user actually presses Fn. The speculative
    // SFSpeechRecognizer warmup request that used to live here was removed
    // too — it leaked a live TLS session to Apple's speech backend for the
    // app's full lifetime and is dubious value vs. paying 300ms once on
    // the user's first real dictation.

    return true
}

/// Prepare the audio engine + recognizer + converter + recording buffer.
/// Does NOT start the engine or start recognition — those happen in
/// handleStart() when the parent sends "start".
/// FIFO-mode boot (#1540): no engine, no taps, no observers. Marks ingest
/// ready (handleStart's guards check these), starts the pipe reader, emits
/// ready. The parent pump opens the write end per-session; between sessions
/// the reader just waits.
func prepareFifoIngest(path: String) {
    guard configureRecognizer(localeIdentifier: currentLocaleIdentifier) else {
        exit(1)
    }
    nativeFormat = whisperFormat
    audioTapInstalled = true
    startFifoReader(path: path)
    emitReady()
}

/// Read 16kHz mono f32 chunks from the FIFO and run the SAME ingestion the
/// engine tap performed: liveness counter, session gate, recognition append,
/// Whisper sample accumulation, level/peak emission. Audio arrives already in
/// whisperFormat, so no converter is involved.
func startFifoReader(path: String) {
    Thread.detachNewThread {
        // O_NONBLOCK so boot never deadlocks waiting for a writer; the read
        // loop tolerates EAGAIN/empty (no session running) with a short sleep.
        let fd = open(path, O_RDONLY | O_NONBLOCK)
        guard fd >= 0 else {
            emitError("Audio pipe open failed: \(String(cString: strerror(errno)))")
            return
        }
        let chunkFrames = 1024
        let chunkBytes = chunkFrames * MemoryLayout<Float>.size
        var raw = Data()
        var buf = [UInt8](repeating: 0, count: chunkBytes)
        var chunkCounter = 0
        var levelGate = LevelGate()

        while true {
            let n = read(fd, &buf, chunkBytes)
            if n <= 0 {
                if n < 0 && errno != EAGAIN && errno != EINTR {
                    emitError("Audio pipe read failed: \(String(cString: strerror(errno)))")
                    return
                }
                usleep(20_000)
                continue
            }
            raw.append(contentsOf: buf[0..<n])

            while raw.count >= chunkBytes {
                let chunk = raw.prefix(chunkBytes)
                raw.removeFirst(chunkBytes)
                tapBufferCount &+= 1
                if currentSessionId == 0 { continue }

                guard let pcm = AVAudioPCMBuffer(pcmFormat: whisperFormat, frameCapacity: AVAudioFrameCount(chunkFrames)),
                      let dst = pcm.floatChannelData?[0] else { continue }
                chunk.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
                    dst.update(from: src.bindMemory(to: Float.self).baseAddress!, count: chunkFrames)
                }
                pcm.frameLength = AVAudioFrameCount(chunkFrames)

                currentRequest?.append(pcm)
                recordedSamples.append(contentsOf: UnsafeBufferPointer(start: dst, count: chunkFrames))

                // The peak keeps its every-3-chunks sampling; the level is
                // sent at most every ~33ms of wall time.
                chunkCounter += 1
                let peakDue = chunkCounter % 3 == 0
                let levelDue = levelGate.open(at: ProcessInfo.processInfo.systemUptime)
                if peakDue || levelDue {
                    var sumOfSquares: Float = 0
                    var peak: Float = 0
                    for i in 0..<chunkFrames {
                        let sample = dst[i]
                        sumOfSquares += sample * sample
                        peak = max(peak, abs(sample))
                    }
                    if peakDue && peak > sessionPeakSample {
                        sessionPeakSample = peak
                    }
                    if levelDue {
                        let rms = sqrt(sumOfSquares / Float(chunkFrames))
                        emitLevel(meterLevel(rms: rms), sessionId: currentSessionId)
                    }
                }
            }
        }
    }
}

func prepareAudioEngine() {
    guard configureRecognizer(localeIdentifier: currentLocaleIdentifier),
          configureAudioInputGraph() else {
        exit(1)
    }

    // A configuration change (device unplugged, sample-rate switch) leaves the
    // prepared graph stale — the engine can claim isRunning while delivering
    // nothing. object: nil on purpose: the engine instance is swapped on every
    // cold start (rebuildAudioEngine), an instance-bound observer would go
    // stale with it. Mid-session, rebuild immediately so the dictation
    // survives the device change; idle, just mark for rebuild at next start.
    //
    // FENCE (the intermittent "microphone is silent" red pill): our OWN
    // rebuild tears down one engine and starts another, and BOTH ends of that
    // swap can post .AVAudioEngineConfigurationChange — which this object:nil
    // observer receives, triggering another rebuild, whose notifications
    // trigger another… The storm keeps replacing the tap mid-session, the
    // first 1.5s delivers zeros, and the zero-fill detector fires a scary
    // error even though the NEXT press works fine. Suppress observer-driven
    // rebuilds for a short window after any rebuild this observer initiated.
    NotificationCenter.default.addObserver(
        forName: .AVAudioEngineConfigurationChange,
        object: nil,
        queue: .main
    ) { _ in
        if configChangeRebuildFenceActive { return }
        if currentSessionId != 0 {
            configChangeRebuildFenceActive = true
            emit("status", "audio_engine_config_changed_rebuilding", sessionId: currentSessionId)
            if rebuildAudioEngine(sessionId: currentSessionId) {
                try? audioEngine.start()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                configChangeRebuildFenceActive = false
            }
        } else {
            engineNeedsRebuild = true
        }
    }

    emitReady()
}

/// Begin a new dictation session in response to the "start" command.
/// The audio engine + tap are ALREADY running (installed in prepareAudioEngine);
/// all we do here is reset per-session state, create a fresh recognition task,
/// and flip `currentSessionId` so the hot tap starts routing audio into it.
func handleStart(sessionId: UInt64) {
    // Rapid-tap recovery. If a previous session is mid-finalize (isShuttingDown
    // is true, the recognition task has been asked to finish(), and the final
    // callback hasn't fired yet), the OLD behavior was to queue this new start
    // and only honor it after the old session emitted "complete". That meant
    // the user's next Fn press → panel → first spoken words all hit a
    // currentSessionId=0 gate and were discarded. Under rapid tapping this
    // read as "the app just broke — nothing's happening."
    //
    // Instead: force-cancel the old task, emit a best-effort complete so the
    // Rust side doesn't sit on a session it will never see finalize, and fall
    // through to the fresh-session setup below.
    if isShuttingDown {
        recognitionTask?.cancel()
        recognitionTask = nil
        currentRequest = nil
        cancelAnalyzerSessionIfActive()
        shutdownGeneration &+= 1
        if !shutdownEmitted {
            let stoppedId = finalizingSessionId != 0 ? finalizingSessionId : currentSessionId
            shutdownEmitted = true
            // Recover the interrupted session's words instead of dropping them.
            // Emit whatever was accumulated as a final (same logic as the normal
            // finalize path) before the complete, so the Rust side can still
            // paste it rather than seeing a bare complete with no transcript.
            let recovered: String
            if !sessionTranscript.isEmpty {
                recovered = accumulatedTranscript.isEmpty
                    ? sessionTranscript
                    : accumulatedTranscript + " " + sessionTranscript
            } else {
                recovered = accumulatedTranscript
            }
            if !recovered.isEmpty {
                emit("final", recovered, sessionId: stoppedId)
            }
            emit("complete", "", sessionId: stoppedId)
        }
        isShuttingDown = false
        finalizingSessionId = 0
        pendingStartSessionId = nil
    }

    // Reset per-session state BEFORE opening the gate. We want the first
    // buffer the tap delivers for this session to land in a clean slate.
    sessionTranscript = ""
    accumulatedTranscript = ""
    isShuttingDown = false
    shutdownEmitted = false
    recordedSamples.removeAll(keepingCapacity: true)
    sessionPeakSample = 0

    guard audioTapInstalled, nativeFormat != nil else {
        emitError("Audio engine not prepared.", sessionId: sessionId)
        return
    }

    // A fresh session cancels any pending hot-linger engine stop (the fence
    // checks the generation at fire time).
    engineLingerGeneration &+= 1

    // Cold start (linger expired and stopped the engine, or a config change
    // invalidated the graph): RECREATE the engine instead of restarting the
    // stopped one — a restarted engine's AUHAL stalls for whole sessions on
    // Intel (#1534, see rebuildAudioEngine). A warm lingering engine is left
    // untouched: buffers are already flowing, restart would only add latency.
    if !audioFifoMode, engineNeedsRebuild || !audioEngine.isRunning {
        guard rebuildAudioEngine(sessionId: sessionId) else {
            emitError("Audio engine rebuild failed.", sessionId: sessionId)
            return
        }
        do {
            try audioEngine.start()
        } catch {
            emitError("Failed to restart audio engine: \(error.localizedDescription)", sessionId: sessionId)
            return
        }
    }

    // Open the gate the INSTANT the engine is live — before recognition-task
    // setup — so the earliest buffers land in `recordedSamples` (the Whisper
    // WAV hears the true head of the utterance) instead of being discarded.
    // `currentRequest?.append` is nil-safe, and SFSpeechAudioBufferRecognition-
    // Request buffers appended audio, so Apple loses at most the few ms until
    // the request is assigned below. (2026-07-08: first words were missing on
    // both Fn and Right-Option — the gate used to open only AFTER task setup.)
    currentSessionId = sessionId
    startRecognitionSession(sessionId: sessionId)

    emit("status", "listening", sessionId: sessionId)

    // Zero-buffer watchdog (#1534): if the tap has delivered NOTHING 450ms
    // after the gate opened, the AUHAL is stalled — rebuild the engine in
    // place (the recognition request survives; the session continues, losing
    // at most the watchdog window instead of the whole dictation). If the
    // REBUILT engine is also silent after a further second, tell the user
    // instead of silently finalizing an empty transcript.
    if audioFifoMode {
        // FIFO-mode liveness (#1540): the parent pump should be delivering
        // chunks within ~1s of session start. If the counter never moves the
        // pump/pipe is dead — say so instead of finalizing empty.
        //
        // Cold-start grace (first-press red pill, 2026-07-12): the very first
        // AudioUnit open per app process pays macOS's cold CoreAudio/HAL
        // activation tax (worse on Intel) — the pump is healthy, first samples
        // just take >1s. tapBufferCount == 0 means no FIFO audio has EVER
        // arrived this helper lifetime, so give that one cold path 3s before
        // declaring the pipe dead; warm sessions keep the tight 1s deadline.
        let fifoBaseline = tapBufferCount
        let livenessDeadline: TimeInterval = fifoBaseline == 0 ? 3.0 : 1.0
        DispatchQueue.main.asyncAfter(deadline: .now() + livenessDeadline) {
            guard currentSessionId == sessionId, tapBufferCount == fifoBaseline else { return }
            emitError("No audio is arriving from the app's microphone stream. Quit and reopen o8.", sessionId: sessionId)
        }
        // Session + "listening" already started above this block — this path
        // adds ONLY the liveness check; the engine watchdogs below are
        // meaningless here (no engine exists in this mode).
        return
    }

    let watchdogBaseline = tapBufferCount
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
        guard currentSessionId == sessionId, tapBufferCount == watchdogBaseline else { return }
        emit("status", "audio_engine_stalled_rebuilding", sessionId: sessionId)
        if rebuildAudioEngine(sessionId: sessionId) {
            do {
                try audioEngine.start()
            } catch {
                emitError("Microphone restart failed: \(error.localizedDescription)", sessionId: sessionId)
                return
            }
        }
        let rebuiltBaseline = tapBufferCount
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            guard currentSessionId == sessionId, tapBufferCount == rebuiltBaseline else { return }
            emitError("Microphone produced no audio. Try again, or check the Input device in Voice settings.", sessionId: sessionId)
        }
    }

    // Zero-FILL detector (#1534): buffers flow but every sample is EXACTLY
    // 0.0. Cause is NOT TCC — measured on the affected Intel machine, the
    // helper's kTCCServiceMicrophone resolves 'Allowed' and the 'Unknown'
    // kTCCServiceAudioCapture verdict is normal (a Terminal ffmpeg capturing
    // real audio gets the same verdict). Root cause still open; this detector
    // exists so the failure is LOUD instead of a silent empty transcript. A real mic never sits at exact digital zero (thermal
    // noise floor keeps the LSBs moving), so peak == 0 after 1.5s of live
    // buffers is conclusive. Surface it as an error — the OLD behavior was a
    // silent empty transcript that looked like "dictation just doesn't work".
    let zeroFillStart = tapBufferCount
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        guard currentSessionId == sessionId,
              tapBufferCount != zeroFillStart,
              sessionPeakSample == 0 else { return }
        // SELF-HEAL first (2026-07-13): the operator's live pattern was
        // "red pill on this press, works on the next press" — i.e. the AUHAL
        // that zero-fills is transient and a fresh engine hears fine. Do the
        // rebuild the user's second press would have done, silently, and only
        // surface the scary error if the REBUILT engine also delivers zeros.
        emit("status", "audio_engine_zero_fill_rebuilding", sessionId: sessionId)
        if rebuildAudioEngine(sessionId: sessionId) {
            try? audioEngine.start()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            guard currentSessionId == sessionId, sessionPeakSample == 0 else { return }
            emit("status", "audio_engine_zero_fill", sessionId: sessionId)
            emitError(
                "The microphone is delivering silent audio. Quit and reopen o8; if it persists, restart the Mac.",
                sessionId: sessionId
            )
        }
    }
}

// MARK: - Main

if CommandLine.arguments.contains("--permissions-json") {
    emitCurrentPermissionsAndExit()
}

if CommandLine.arguments.contains("--request-permissions") {
    requestPermissionsAndExit()
    RunLoop.main.run()
}

if CommandLine.arguments.contains("--input-devices-json") {
    emitInputDevicesAndExit()
}

/// Explicitly request MICROPHONE access before anything touches the engine.
///
/// Under the disclaimed-responsibility spawn (#1534 v2) the helper is its own
/// TCC client — and its mic state starts `notDetermined` on every machine
/// where only the app identity was ever granted. CoreAudio does NOT reliably
/// auto-prompt for a background helper's first input IO; it just delivers
/// zero-filled buffers (the exact silent-capture the zero-fill watchdog
/// flags). Same failure class this file already fixed for Speech Recognition
/// ("left a fresh install permanently notDetermined → EMPTY transcripts") —
/// the mic needs the same explicit ask. One system prompt ("o8 Speech
/// Helper"), one Allow, own TCC row, real audio.
func requestMicrophoneAccess(completion: @escaping (Bool) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        completion(true)
    case .notDetermined:
        emit("status", "microphone:requesting")
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                emit("status", granted ? "microphone:granted" : "microphone:denied")
                completion(granted)
            }
        }
    default:
        // denied / restricted — surface it loudly instead of recording zeros.
        emit("status", "microphone:denied")
        emitError(
            "o8 Speech Helper has no microphone access. Enable it in System Settings → Privacy & Security → Microphone, then relaunch o8.",
            sessionId: nil
        )
        completion(false)
    }
}

if let fifoPath = audioFifoPath {
    // Main-process capture (#1540): the PARENT owns the mic (its TCC identity
    // is the one 15.7.8 still honors) — this helper needs no mic access at
    // all. Speech Recognition auth is still ours.
    requestAuthorization { authorized in
        guard authorized else { exit(1) }
        DispatchQueue.main.async {
            prepareFifoIngest(path: fifoPath)
        }
    }
} else {
    requestMicrophoneAccess { micGranted in
        // Even without the mic we keep booting: the daemon still answers
        // status/permission queries, and the zero-fill watchdog + the error above
        // tell the operator exactly what to fix — a hard exit here would just
        // read as "dictation does nothing" again.
        _ = micGranted
        requestAuthorization { authorized in
            guard authorized else { exit(1) }
            DispatchQueue.main.async {
                prepareAudioEngine()
            }
        }
    }
}

// Stdin reader loop — runs on a background queue, dispatches commands to main.
DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        let cmd = line.trimmingCharacters(in: .whitespacesAndNewlines)
        DispatchQueue.main.async {
            if cmd == "quit" {
                handleQuit()
                return
            }

            if cmd == "start" {
                handleStart(sessionId: 0)
                return
            }

            if cmd == "stop" {
                stopSession()
                return
            }

            if cmd.hasPrefix("start:"),
               let sessionId = UInt64(cmd.dropFirst("start:".count)) {
                handleStart(sessionId: sessionId)
                return
            }

            if cmd.hasPrefix("stop:"),
               let sessionId = UInt64(cmd.dropFirst("stop:".count)) {
                stopSession(requestedSessionId: sessionId)
                return
            }

            if cmd.hasPrefix("locale:") {
                handleLocaleUpdate(String(cmd.dropFirst("locale:".count)))
                return
            }

            if cmd.hasPrefix("on_device:") {
                let raw = String(cmd.dropFirst("on_device:".count)).lowercased()
                handleOnDeviceUpdate(raw == "true" || raw == "1")
                return
            }

            if cmd.hasPrefix("input_device:") {
                handleInputDeviceUpdate(String(cmd.dropFirst("input_device:".count)))
                return
            }
        }
    }
    // stdin closed → parent died, exit gracefully
    DispatchQueue.main.async { handleQuit() }
}

RunLoop.main.run()
