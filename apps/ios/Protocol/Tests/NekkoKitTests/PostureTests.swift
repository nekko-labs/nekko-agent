import Foundation
import XCTest
@testable import NekkoKit

/// Every row of the spec's posture table, iPad and Surface Duo cases, from the
/// fixture the Android tests read too (`posture.json`).
final class PostureTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Bounds: Decodable { let x, y, width, height: Double }
        struct Hinge: Decodable {
            let bounds: Bounds
            let state: String
            let orientation: String
            let isSeparating: Bool
        }
        struct Input: Decodable {
            let widthDp, heightDp: Double
            let widthClass, heightClass: String
            let hinge: Hinge?
        }
        struct Case: Decodable {
            let name: String
            let input: Input
            let expected: String
        }
        let cases: [Case]
    }

    private func cases() throws -> [Fixture.Case] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "posture", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).cases
    }

    /// Android's window size classes: compact, or medium / expanded (regular here).
    private func sizeClass(_ s: String) -> PostureSizeClass { s == "compact" ? .compact : .regular }

    private func input(_ i: Fixture.Input) -> PostureInput {
        let hinge = i.hinge.map { h in
            PostureHinge(
                rect: CGRect(x: h.bounds.x, y: h.bounds.y, width: h.bounds.width, height: h.bounds.height),
                state: h.state == "halfOpened" ? .halfOpened : .flat,
                isSeparating: h.isSeparating
            )
        }
        return PostureInput(horizontal: sizeClass(i.widthClass), vertical: sizeClass(i.heightClass), size: CGSize(width: i.widthDp, height: i.heightDp), hinge: hinge)
    }

    func testEveryFixtureCase() throws {
        let all = try cases()
        XCTAssertGreaterThanOrEqual(all.count, 15)
        for c in all {
            let i = input(c.input)
            XCTAssertEqual(Posture.from(i).rawValue, c.expected, c.name)
            if let h = c.input.hinge { XCTAssertEqual(i.hinge?.orientation.rawValue, h.orientation, "\(c.name): orientation") }
        }
        // Every posture is exercised.
        XCTAssertEqual(Set(all.map(\.expected)), Set(Posture.allCases.map(\.rawValue)))
    }

    func testUnder600IsAlwaysClosed() {
        let fold = PostureHinge(rect: CGRect(x: 0, y: 400, width: 599, height: 0), state: .halfOpened)
        XCTAssertEqual(Posture.from(PostureInput(horizontal: .regular, vertical: .regular, size: CGSize(width: 599, height: 800), hinge: fold)), .closed)
    }

    @MainActor func testTheHingeSourceIsInjectable() {
        defer { Posture.hingeSource = { nil } }
        let size = CGSize(width: 841, height: 673)
        XCTAssertEqual(Posture.current(horizontal: .regular, vertical: .regular, size: size), .openWide)
        Posture.hingeSource = { PostureHinge(rect: CGRect(x: 0, y: 336, width: 841, height: 0), state: .halfOpened) }
        XCTAssertEqual(Posture.current(horizontal: .regular, vertical: .regular, size: size), .tabletop)
    }

    func testTheAndroidCopyOfTheFixtureMatches() throws {
        // Tests/NekkoKitTests/PostureTests.swift -> repo root is five levels up.
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../..").standardized
        let android = root.appendingPathComponent("apps/android/protocol/src/test/resources/posture.json")
        guard FileManager.default.fileExists(atPath: android.path) else { throw XCTSkip("no Android checkout beside this package") }
        let ours = try XCTUnwrap(Bundle.module.url(forResource: "posture", withExtension: "json", subdirectory: "Fixtures"))
        XCTAssertEqual(try Data(contentsOf: android), try Data(contentsOf: ours))
    }
}
