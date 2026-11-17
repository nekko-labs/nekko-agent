import XCTest
@testable import NekkoProtocol

final class ConnectChecklistTests: XCTestCase {
    func testFirstMessageWithNothingConnectedShowsEveryRowAndTheFolderWaits() {
        guard case .checklist(let rows) = ConnectChecklist.shown(computer: nil, folder: nil, git: nil, tasks: nil, sentBefore: false, closed: false) else {
            return XCTFail("expected the checklist")
        }
        XCTAssertEqual(rows.map(\.item), [.computer, .folder, .git, .tasks])
        XCTAssertEqual(rows.filter(\.isDone).count, 0)
        XCTAssertEqual(rows.first { $0.item == .folder }?.waiting, true)
    }

    func testDoneRowsNameWhatGotConnected() {
        guard case .checklist(let rows) = ConnectChecklist.shown(computer: "MacBook Pro", folder: "nekko-agent", git: nil, tasks: nil, sentBefore: false, closed: false) else {
            return XCTFail("expected the checklist")
        }
        XCTAssertEqual(rows.map(\.done), ["MacBook Pro", "nekko-agent", nil, nil])
        XCTAssertFalse(rows.contains(where: \.waiting))
    }

    func testAllDoneOrClosedShowsNothing() {
        XCTAssertEqual(ConnectChecklist.shown(computer: "Mac", folder: "app", git: "GitHub", tasks: "Linear", sentBefore: false, closed: false), .nothing)
        XCTAssertEqual(ConnectChecklist.shown(computer: nil, folder: nil, git: nil, tasks: nil, sentBefore: false, closed: true), .nothing)
        XCTAssertEqual(ConnectChecklist.shown(computer: nil, folder: nil, git: nil, tasks: nil, sentBefore: true, closed: true), .nothing)
    }

    func testAfterTheFirstMessageTheNoteShowsOnlyWhileNothingIsConnected() {
        XCTAssertEqual(ConnectChecklist.shown(computer: nil, folder: nil, git: nil, tasks: nil, sentBefore: true, closed: false), .note)
        // A task tool alone gives Nekko no files or tools to use.
        XCTAssertEqual(ConnectChecklist.shown(computer: nil, folder: nil, git: nil, tasks: "Linear", sentBefore: true, closed: false), .note)
        XCTAssertEqual(ConnectChecklist.shown(computer: "gomi", folder: nil, git: nil, tasks: nil, sentBefore: true, closed: false), .nothing)
        XCTAssertEqual(ConnectChecklist.shown(computer: nil, folder: nil, git: "GitHub", tasks: nil, sentBefore: true, closed: false), .nothing)
    }

    func testSentBeforeCountsAnyExchangeAndUnknownCounts() {
        XCTAssertFalse(ConnectChecklist.sentBefore(remembered: false, exchangeCounts: []))
        XCTAssertFalse(ConnectChecklist.sentBefore(remembered: false, exchangeCounts: [0, 0]))
        XCTAssertTrue(ConnectChecklist.sentBefore(remembered: false, exchangeCounts: [0, 3]))
        XCTAssertTrue(ConnectChecklist.sentBefore(remembered: false, exchangeCounts: [nil]))
        XCTAssertTrue(ConnectChecklist.sentBefore(remembered: true, exchangeCounts: []))
    }
}
