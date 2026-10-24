import XCTest
@testable import NekkoKit
import NekkoProtocol

/// Provider setup from the phone (decision 0016): the request carries the
/// provider without its key and the key sealed to the computer; the computer
/// (a software key here) opens it; the phone keeps nothing.
final class ProviderSetupTests: XCTestCase {
    func testSealsTheKeyToTheComputerAndOpensThereOnly() throws {
        let computer = SyncCrypto.SoftwareKey()
        let request = try ProviderSetup.request(id: "anthropic", kind: "anthropic", label: " Anthropic ", baseUrl: nil, key: " sk-ant-secret ", computerKey: computer.publicKeyX963)
        XCTAssertEqual(request.str("id"), "anthropic")
        XCTAssertEqual(request.str("kind"), "anthropic")
        XCTAssertEqual(request.str("label"), "Anthropic")
        XCTAssertNil(request["baseUrl"], "the kind's default address is the computer's to fill in")
        XCTAssertNil(request["apiKey"])
        let blob = try XCTUnwrap(request.str("sealedKey"))
        XCTAssertFalse(blob.contains("sk-ant"))
        XCTAssertFalse(request.serialized().contains("sk-ant-secret"))
        let opened = try SyncCrypto.openSealed(key: computer, context: ProviderSetup.context, blob: blob)
        XCTAssertEqual(String(decoding: opened, as: UTF8.self), "sk-ant-secret")
        let other = SyncCrypto.SoftwareKey()
        XCTAssertThrowsError(try SyncCrypto.openSealed(key: other, context: ProviderSetup.context, blob: blob))
        XCTAssertThrowsError(try SyncCrypto.openSealed(key: computer, context: "other", blob: blob))
    }

    func testLocalKindsNeedNoKeyAndCloudKindsNeedHttps() throws {
        let computer = SyncCrypto.SoftwareKey()
        let ollama = try ProviderSetup.request(id: "ollama", kind: "ollama", label: "Ollama", baseUrl: "http://localhost:11434", key: nil, computerKey: computer.publicKeyX963)
        XCTAssertEqual(ollama.str("baseUrl"), "http://localhost:11434")
        XCTAssertNil(ollama["sealedKey"])
        XCTAssertThrowsError(try ProviderSetup.request(id: "o", kind: "openai", label: "OpenAI", baseUrl: nil, key: "", computerKey: computer.publicKeyX963)) { XCTAssertEqual($0 as? ProviderSetup.Problem, .key) }
        XCTAssertThrowsError(try ProviderSetup.request(id: "o", kind: "openai", label: "", baseUrl: nil, key: "sk", computerKey: computer.publicKeyX963)) { XCTAssertEqual($0 as? ProviderSetup.Problem, .label) }
        XCTAssertThrowsError(try ProviderSetup.request(id: "o", kind: "openai", label: "x", baseUrl: "http://api.openai.com/v1", key: "sk", computerKey: computer.publicKeyX963)) { XCTAssertEqual($0 as? ProviderSetup.Problem, .url) }
        XCTAssertThrowsError(try ProviderSetup.request(id: "o", kind: "openai", label: "x", baseUrl: nil, key: "sk", computerKey: Data([4, 5]))) { XCTAssertEqual($0 as? ProviderSetup.Problem, .computerKey) }
    }

    func testIdsAreSlugsUniqueAmongTheComputersProviders() {
        XCTAssertEqual(ProviderSetup.id(for: "Anthropic", kind: "anthropic", existing: []), "anthropic")
        XCTAssertEqual(ProviderSetup.id(for: "My OpenAI  key!", kind: "openai", existing: []), "my-openai-key")
        XCTAssertEqual(ProviderSetup.id(for: "Anthropic", kind: "anthropic", existing: ["anthropic", "anthropic-2"]), "anthropic-3")
        XCTAssertEqual(ProviderSetup.id(for: "日本語", kind: "openrouter", existing: []), "openrouter")
    }

    func testDecodesASaveResult() throws {
        let r = ProviderSaveResult.from(try JSONValue.parse(#"{"ok":true,"models":[{"id":"m1","name":"Model 1"},{"id":"m2"},{"name":"no id"}]}"#))
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.models.map(\.name), ["Model 1", "m2"])
        let failed = ProviderSaveResult.from(try JSONValue.parse(#"{"ok":false,"message":"401"}"#))
        XCTAssertFalse(failed.ok)
        XCTAssertEqual(failed.message, "401")
        XCTAssertFalse(ProviderSaveResult.from(nil).ok)
    }
}
