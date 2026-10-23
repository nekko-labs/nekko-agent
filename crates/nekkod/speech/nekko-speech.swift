// nekko-speech: Apple's on-device speech recognizer (SpeechAnalyzer, macOS 26+)
// as a one-shot command for the engine daemon (crates/nekkod/src/voice.rs).
// Built by apps/desktop/scripts/stage-daemon.mjs and staged beside nekkod.
//
// One JSON object on stdout per run; a failure prints {"error": ...} and exits 1.
//   status [lang]            {"supported", "installed", "locale", "reason"?}
//   install [lang]           downloads the locale's assets  -> {"installed": true, "locale"}
//   uninstall [lang]         releases the locale            -> {"installed": false, "locale"}
//   transcribe <wav> [lang]  {"text"}
// `lang` is the settings' recognition language: "en", "en-US" or "auto".
import AVFoundation
import Foundation
import Speech

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

func fail(_ message: String) -> Never {
    emit(["error": message])
    exit(1)
}

@available(macOS 26, *)
func tag(_ locale: Locale) -> String { locale.identifier(.bcp47) }

/// The locale the request means: an exact tag first, then the current locale
/// when its language matches, then any installed one, then any supported one.
@available(macOS 26, *)
func resolve(_ code: String) async -> (Locale, installed: Bool)? {
    let installed = await SpeechTranscriber.installedLocales
    let supported = await SpeechTranscriber.supportedLocales
    let known = installed + supported
    let isInstalled = { (l: Locale) in installed.contains { tag($0) == tag(l) } }
    let pick = { (l: Locale) in (l, installed: isInstalled(l)) }
    let wanted = code.isEmpty || code == "auto" ? Locale.current : Locale(identifier: code)
    if let exact = known.first(where: { tag($0).lowercased() == tag(wanted).lowercased() }) { return pick(exact) }
    let language = wanted.language.languageCode?.identifier
    let same = { (l: Locale) in l.language.languageCode?.identifier == language }
    if same(Locale.current), let current = known.first(where: { tag($0) == tag(Locale.current) }) { return pick(current) }
    // "fr" means fr-FR before fr-BE: the region that spells the language.
    let home = { (l: Locale) in tag(l).lowercased() == "\(language ?? "")-\(language ?? "")" }
    return (installed.first(where: same) ?? supported.first(where: home) ?? supported.first(where: same)).map(pick)
}

@available(macOS 26, *)
func run(_ args: [String]) async throws {
    let command = args.first ?? "status"
    let code = command == "transcribe" ? (args.count > 2 ? args[2] : "") : (args.count > 1 ? args[1] : "")
    guard let (locale, installed) = await resolve(code) else {
        if command == "status" { return emit(["supported": false, "installed": false, "reason": "Apple speech has no on-device model for \(code.isEmpty ? "this language" : code)."]) }
        fail("Apple speech has no on-device model for \(code).")
    }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    switch command {
    case "status":
        emit(["supported": true, "installed": installed, "locale": tag(locale)])
    case "install":
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        emit(["installed": true, "locale": tag(locale)])
    case "uninstall":
        await AssetInventory.release(reservedLocale: locale)
        emit(["installed": false, "locale": tag(locale)])
    case "transcribe":
        guard args.count > 1 else { fail("transcribe needs a WAV path.") }
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[1]))
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        async let text: String = {
            var out = ""
            for try await result in transcriber.results where result.isFinal { out += String(result.text.characters) }
            return out
        }()
        if let last = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        emit(["text": try await text.trimmingCharacters(in: .whitespacesAndNewlines)])
    default:
        fail("Unknown command \(command).")
    }
}

let args = Array(CommandLine.arguments.dropFirst())
if #available(macOS 26, *) {
    do { try await run(args) } catch { fail("\(error.localizedDescription)") }
} else if args.first ?? "status" == "status" {
    emit(["supported": false, "installed": false, "reason": "Apple on-device speech needs macOS 26 or newer."])
} else {
    fail("Apple on-device speech needs macOS 26 or newer.")
}
