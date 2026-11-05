import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

final class WorkspaceTests: XCTestCase {
    func testDefaultFolderSettingsDecodeWithoutHostPaths() {
        let settings = PcSettings.from(["defaultWorkspaceIds": ["w", "other"], "workspaces": [["path": "/private"]]])
        XCTAssertEqual(settings.defaultWorkspaceIds, ["w", "other"])
        XCTAssertEqual(PcSettings.from([:]).defaultWorkspaceIds, [])
    }

    func testDefaultIntentAndSupportingFoldersSurvivePersistence() {
        let draft = Draft(text: "Hello", workspaceId: "app", useDefaultFolders: true)
        XCTAssertEqual(Draft.from(draft.json)?.useDefaultFolders, true)
        let spec = NewChatSpec(providerId: "p", modelId: "m", workspaceId: "app", supportingWorkspaceIds: ["docs"])
        XCTAssertEqual(NewChatSpec.from(spec.json)?.supportingWorkspaceIds, ["docs"])
        XCTAssertEqual(NewChatSpec.from(["providerId": "p", "modelId": "m"])?.supportingWorkspaceIds, [])
    }

    func testPathsAndLegacyFoldersRoundTripThroughCache() {
        let folders = WorkspaceFolder.list([["id": "a", "name": "App", "path": "/Users/me/App"], ["id": "b", "name": "Old"]])
        XCTAssertEqual(folders, [WorkspaceFolder(id: "a", name: "App", path: "/Users/me/App"), WorkspaceFolder(id: "b", name: "Old")])
        let saved = SavedChatList(savedAt: 42, summaries: [], folders: folders)
        XCTAssertEqual(SavedChatList.from(saved.json), saved)
    }

    func testAbsoluteHostPathsNotPhoneResolution() {
        for path in ["/Users/me/app", "C:\\Users\\me\\app", "D:/projects/app", "\\\\studio\\projects\\app"] {
            XCTAssertTrue(WorkspacePath.isAbsolute(path), path)
        }
        for path in ["", "~/app", "relative/app", "C:app", "\\app", "/bad\0path", "/bad\npath"] {
            XCTAssertFalse(WorkspacePath.isAbsolute(path), path)
        }
        XCTAssertTrue(Channels.change.contains(Channels.workspaceAddByPath))
        XCTAssertTrue(Channels.change.contains(Channels.workspaceRemove))
    }
}

@MainActor
final class WorkspaceStoreTests: XCTestCase {
    func testSignedAddRemoveFullListAndRefreshedSummaries() async throws {
        let computer = ProofComputer(deviceId: "id-1")
        let store = await StoreChangeTests.pairedStore(computer)
        store.changeSigner = SoftwareChangeSigner()
        computer.now = Int64(Date().timeIntervalSince1970 * 1000)
        computer.replies = [Channels.sessionsSummaries: [], Channels.providersList: [], Channels.settingsGet: [:], Channels.workspaceList: []]
        computer.online()
        for _ in 0..<20 { await Task.yield() }
        computer.replies[Channels.workspaceAddByPath] = [["id": "w", "name": "App", "path": "/projects/app"]]
        try await store.addWorkspace(path: "  /projects/app  ")
        XCTAssertEqual(store.workspaces, [WorkspaceFolder(id: "w", name: "App", path: "/projects/app")])
        XCTAssertEqual(computer.proofs(Channels.workspaceAddByPath), [true])
        computer.replies[Channels.settingsUpdate] = ["defaultWorkspaceIds": ["w"]]
        try await store.setDefaultWorkspace("w", included: true)
        XCTAssertEqual(store.pcSettings.defaultWorkspaceIds, ["w"])
        XCTAssertEqual(computer.calls.last(where: { $0.0 == Channels.settingsUpdate })?.1, [["defaultWorkspaceIds": ["w"]]])
        computer.replies[Channels.workspaceRemove] = []
        computer.replies[Channels.sessionsSummaries] = [["id": "chat", "title": "Unassigned", "updatedAt": 5]]
        try await store.removeWorkspace("w")
        XCTAssertTrue(store.workspaces.isEmpty)
        XCTAssertEqual(store.summaries.first?.id, "chat")
        XCTAssertNil(store.summaries.first?.workspaceId)
        XCTAssertEqual(computer.proofs(Channels.workspaceRemove), [true])
        let args = computer.calls.filter { $0.0 == Channels.workspaceAddByPath || $0.0 == Channels.workspaceRemove }.map(\.1)
        XCTAssertEqual(args, [[.string("/projects/app")], [.string("w")]])
        computer.changeOn = false
        do { try await store.addWorkspace(path: "/refused"); XCTFail("must refuse") }
        catch { XCTAssertTrue(error.localizedDescription.contains("turned off")) }
        XCTAssertTrue(store.workspaces.isEmpty)
    }

    func testNewChatAttachesSupportingFoldersWithASignedProof() async throws {
        let computer = ProofComputer(deviceId: "id-1")
        let store = await StoreChangeTests.pairedStore(computer)
        store.changeSigner = SoftwareChangeSigner()
        computer.now = Int64(Date().timeIntervalSince1970 * 1000)
        computer.replies = [Channels.sessionsSummaries: [], Channels.providersList: [], Channels.settingsGet: [:], Channels.workspaceList: [],
                            Channels.sessionCreate: ["id": "chat", "messages": []], Channels.sessionSetOptions: .null,
                            Channels.sessionSetSupportingWorkspaces: .null]
        computer.online()
        for _ in 0..<20 { await Task.yield() }
        let id = try await store.createChat(providerId: "p", modelId: "m", workspaceId: "app", mode: .guardrails, supportingWorkspaceIds: ["docs"])
        XCTAssertEqual(id, "s-new")
        XCTAssertEqual(computer.proofs(Channels.sessionSetSupportingWorkspaces), [true])
        XCTAssertEqual(computer.calls.last(where: { $0.0 == Channels.sessionSetSupportingWorkspaces })?.1, ["s-new", ["docs"]])
    }

    func testOfflineAndRelativePathsDoNotSendChanges() async throws {
        let computer = ProofComputer(deviceId: "id-1")
        let store = await StoreChangeTests.pairedStore(computer)
        for path in ["relative", "/absolute"] {
            do { try await store.addWorkspace(path: path); XCTFail("must refuse") } catch {}
        }
        do { try await store.removeWorkspace("w"); XCTFail("must refuse") } catch {}
        XCTAssertFalse(computer.channels().contains(Channels.workspaceAddByPath))
        XCTAssertFalse(computer.channels().contains(Channels.workspaceRemove))
    }
}
