import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

@MainActor
final class PhotoPreviewTests: XCTestCase {
    func testOutgoingPhotosStayVisibleWhenSavedRowsKeepTheirLiveIds() async throws {
        let (store, connection) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: store, now: { 7 })
        await chat.start()?.value
        defer { chat.stop() }
        let original = "data:image/jpeg;base64,original"
        let thumbnail = "data:image/jpeg;base64,thumbnail"
        let sent = try await chat.send("Look at this", images: [original])
        XCTAssertEqual(chat.photos("pending-7"), [original], "the outgoing bubble previews immediately, before the computer answers")
        connection.replies[Channels.sessionGet] = { _ in
            ["id": "s", "messages": [["id": "saved-photo", "role": "user", "content": "Look at this", "images": [.string(thumbnail)]]],
             "queue": [], "clientMessageIds": [.string(sent)]]
        }
        connection.event(["type": "done", "sessionId": "s"])
        await chat.sendTask?.value
        for _ in 0..<20 { await Task.yield() }
        await chat.reload()
        XCTAssertEqual(chat.blocks.first?.id, "pending-7", "the saved row keeps its live identity")
        XCTAssertEqual(chat.photos("pending-7"), [thumbnail], "look up the saved thumbnail through the carried id")
        XCTAssertEqual(chat.photos("saved-photo"), [thumbnail], "the original saved id also works")
        XCTAssertEqual(chat.photos("unknown"), [])

        connection.replies[Channels.sessionGet] = { _ in
            ["id": "s", "messages": [["id": "saved-photo", "role": "user", "content": "Look at this", "images": [""]]], "queue": []]
        }
        await chat.reload()
        XCTAssertEqual(chat.photos("pending-7"), [""], "respect photos the computer kept back, never substitute the original")
    }

    func testRefusedPhotosReturnToDraftAndLeaveNoLivePreview() async throws {
        let (store, connection) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: store, now: { 9 })
        await chat.start()?.value
        defer { chat.stop() }
        connection.replies[Channels.chatSend] = { _ in throw RelayError("Not now.", fromComputer: true) }
        let photos = ["data:image/jpeg;base64,original"]
        _ = try await chat.send("Look", images: photos)
        XCTAssertEqual(chat.photos("pending-9"), photos)
        await chat.sendTask?.value
        XCTAssertEqual(chat.takeUnsent()?.images, photos)
        XCTAssertEqual(chat.photos("pending-9"), [], "a removed outgoing row no longer retains its photos")
    }
}
