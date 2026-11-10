import Foundation
import XCTest
@testable import NekkoKit

/// Intentionally ignores cancellation until released, like a late delegate
/// callback. Generation guards, not cooperative HTTP mocks, must reject it.
private actor DelayedPhoneModels: PhoneHTTP {
    private var pending: [CheckedContinuation<(status: Int, body: Data), Error>] = []
    var count: Int { pending.count }

    func send(_ request: PhoneRequest) async throws -> (status: Int, body: Data) {
        try await withCheckedThrowingContinuation { pending.append($0) }
    }

    func lines(_ request: PhoneRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, Error>) {
        (200, AsyncThrowingStream { $0.finish() })
    }

    func release(_ index: Int, model: String) {
        pending[index].resume(returning: (200, Data("{\"data\":[{\"id\":\"\(model)\"}]}".utf8)))
    }
}

@MainActor
final class PhoneCloudDiscoveryTests: XCTestCase {
    private func wait(_ http: DelayedPhoneModels, count: Int) async throws {
        for _ in 0..<100 {
            if await http.count >= count { return }
            try await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("Model request did not start")
        throw URLError(.timedOut)
    }

    func testOldModelLoadCannotOverwriteNewerLoad() async throws {
        let http = DelayedPhoneModels()
        let s = PhoneChats(secrets: MemoryStore(), http: http)
        let p = try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k")
        let old = Task { await s.loadModels(p.id) }
        try await wait(http, count: 1)
        let fresh = Task { await s.loadModels(p.id) }
        try await wait(http, count: 2)
        await http.release(1, model: "gpt-fresh")
        let freshModels = await fresh.value
        XCTAssertEqual(freshModels.map(\.id), ["gpt-fresh"])
        await http.release(0, model: "gpt-stale")
        _ = await old.value
        XCTAssertEqual(s.models[p.id]?.map(\.id), ["gpt-fresh"])
    }

    func testRekeyDisableRemoveAndForgetFenceLateDiscovery() async throws {
        for action in 0..<4 {
            let http = DelayedPhoneModels()
            let files = MemoryOfflineFiles()
            let s = PhoneChats(secrets: MemoryStore(), files: files, http: http)
            let p = try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k")
            let load = Task { await s.loadModels(p.id) }
            try await wait(http, count: 1)
            switch action {
            case 0: s.setKey(p.id, "new-key")
            case 1: s.setEnabled(p.id, false)
            case 2: s.remove(p.id)
            default: s.forgetAll()
            }
            await http.release(0, model: "gpt-late")
            _ = await load.value
            XCTAssertNil(s.models[p.id])
            XCTAssertNil(s.modelErrors[p.id])
            if action == 3 { XCTAssertTrue(files.files.isEmpty) }
        }
    }

    func testFailedTestDoesNotPassBecauseModelsWereCached() async throws {
        let http = FakePhoneHTTP()
        let s = PhoneChats(secrets: MemoryStore(), http: http)
        let p = try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k")
        _ = await s.loadModels(p.id)
        XCTAssertFalse(s.models[p.id]?.isEmpty ?? true)
        http.responses = [(401, Data("secret".utf8))]
        let error = await s.test(p.id)
        XCTAssertNotNil(error)
        XCTAssertFalse(error?.contains("secret") ?? true)
    }
}
