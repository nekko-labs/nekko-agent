import Foundation
import Translation

// Offline catalog authoring tool. Production and CI never run a translator.
let tag = CommandLine.arguments[1]
let source = Locale.Language(identifier: "en")
let target = Locale.Language(identifier: tag)
if await LanguageAvailability().status(from: source, to: target) != .installed {
    throw NSError(domain: "Install the English and \(tag) languages in System Settings first", code: 1)
}
let session = TranslationSession(installedSource: source, target: target)
struct Record: Codable { let id: String; let source: String }
let decoder = JSONDecoder()
let encoder = JSONEncoder()
while let line = readLine() {
    let batch = try decoder.decode([Record].self, from: Data(line.utf8))
    for try await result in session.translate(batch: batch.map({ .init(sourceText: $0.source, clientIdentifier: $0.id) })) {
        let pair = [result.clientIdentifier ?? "", result.targetText]
        print(String(decoding: try encoder.encode(pair), as: UTF8.self))
    }
    print("null")
    fflush(stdout)
}
