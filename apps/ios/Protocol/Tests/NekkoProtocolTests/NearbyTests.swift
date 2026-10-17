import XCTest
@testable import NekkoProtocol

/// The same cases as Android's NearbyComputerTest, except where its relay rule is
/// stricter (Android allows plain ws:// only to *.ts.net names).
final class NearbyTests: XCTestCase {
    func testAComputerWithItsOwnRelay() {
        let c = NearbyComputer.from(instance: "Studio", txt: ["v": "1", "name": "Studio", "relay": "ws://studio.tail1234.ts.net:4400"])
        XCTAssertEqual(c, NearbyComputer(id: "Studio", name: "Studio", relayUrl: "ws://studio.tail1234.ts.net:4400"))
    }

    func testTheInstanceNameStandsInForAMissingName() {
        XCTAssertEqual(NearbyComputer.from(instance: "Studio", txt: ["v": "1"])?.name, "Studio")
        XCTAssertNil(NearbyComputer.from(instance: "  ", txt: ["v": "1", "name": "\u{0007}"]))
    }

    func testOtherVersionsAreSkipped() {
        XCTAssertNil(NearbyComputer.from(instance: "Studio", txt: ["name": "Studio"]))
        XCTAssertNil(NearbyComputer.from(instance: "Studio", txt: ["v": "2", "name": "Studio"]))
    }

    func testARelayThePhoneWouldRefuseIsNotShown() {
        let relay = { (r: String) in NearbyComputer.from(instance: "S", txt: ["v": "1", "relay": r])?.relayUrl }
        XCTAssertNil(relay("ws://example.com:4400"), "plain ws:// to the internet")
        XCTAssertNil(relay("ws://localhost:4400"), "the phone itself")
        XCTAssertNil(relay("https://studio.tail1234.ts.net"), "not a relay address")
        XCTAssertNil(relay("javascript:alert(1)"))
        XCTAssertEqual(relay("wss://relay.example.com"), "wss://relay.example.com")
        XCTAssertEqual(relay("ws://192.168.1.20:4400"), "ws://192.168.1.20:4400")
    }

    func testNamesAreOneShortLine() {
        let c = NearbyComputer.from(instance: "x", txt: ["v": "1", "name": "Philip’s\nMac\u{0000}  mini" + String(repeating: "!", count: 100)])
        XCTAssertTrue(c?.name.hasPrefix("Philip’s Mac mini") ?? false)
        XCTAssertEqual(c?.name.count, NearbyComputer.maxName)
    }

    func testTheListIsSortedByName() {
        let list = [NearbyComputer(id: "b", name: "studio", relayUrl: nil), NearbyComputer(id: "a", name: "Attic", relayUrl: nil)]
        XCTAssertEqual(NearbyComputer.sorted(list).map(\.id), ["a", "b"])
    }
}
