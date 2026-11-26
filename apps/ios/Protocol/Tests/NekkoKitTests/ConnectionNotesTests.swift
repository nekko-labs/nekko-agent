@testable import NekkoKit
import NekkoProtocol
import XCTest

final class ConnectionNotesTests: XCTestCase {
    private func facts(_ id: String, _ state: RelayState, route: RelayRoute = .internet, detail: String? = nil,
                       denied: DenyReason? = nil, active: Bool = false, waiting: Int = 0,
                       check: ProtocolCheck = .same, disabled: Bool = false, offTailnet: Bool = false) -> ConnectionFacts {
        ConnectionFacts(id: id, name: id.capitalized, route: route, relayHost: "\(id).tail.ts.net", state: state, detail: detail,
                        denied: denied, active: active, disabled: disabled, protocolCheck: check, waiting: waiting,
                        offTailnet: offTailnet)
    }

    func testEveryComputerOnlineSaysNothingButItsName() {
        let notes = ConnectionNotes.make([facts("studio", .online, active: true), facts("gomi", .online)], tailscaleOn: true)
        XCTAssertEqual(notes.map(\.name), ["Studio", "Gomi"])
        XCTAssertEqual(notes.map(\.tone), [.ok, .ok])
        XCTAssertTrue(notes.allSatisfy { $0.word == nil && !$0.opens })
        XCTAssertTrue(ConnectionNotes.problems(notes).isEmpty)
    }

    func testATailnetOnlyComputerSaysTailscaleOffItselfAndNothingLeadsTheRow() {
        let notes = ConnectionNotes.make([facts("studio", .connecting, route: .tailscale, active: true, waiting: 2),
                                          facts("laptop", .offline)], tailscaleOn: false)
        XCTAssertEqual(notes.map(\.id), ["studio", "laptop"])
        let n = notes[0]
        XCTAssertEqual(n.tone, .warning)
        XCTAssertEqual(n.word, "Tailscale off")
        XCTAssertEqual(n.line, "Turn on Tailscale to reach Studio.")
        XCTAssertEqual(n.tail, "2 prompts wait to send.")
        XCTAssertEqual(n.actions, [.openTailscale, .details])
        XCTAssertTrue(n.more)
        XCTAssertEqual(notes[1].word, "offline")
        XCTAssertEqual(notes[1].actions, [.retry])
        XCTAssertFalse(notes[1].more, "the safety exits belong to the active computer")
    }

    func testAnInactiveTailnetOnlyComputerHasNoDetails() {
        let n = ConnectionNotes.make([facts("gomi", .offline, route: .tailscale)], tailscaleOn: false)[0]
        XCTAssertEqual(n.actions, [.openTailscale])
        XCTAssertFalse(n.more)
    }

    func testTailscaleOnLeavesTheTailnetComputerToItsOwnWords() {
        let n = ConnectionNotes.make([facts("studio", .offline, route: .tailscale)], tailscaleOn: true)[0]
        XCTAssertEqual(n.word, "offline")
    }

    func testTailscaleOnButSilentPutsTheWordOnTheComputer() {
        let notes = ConnectionNotes.make([facts("studio", .connecting, route: .tailscale, detail: "timeout", active: true)], tailscaleOn: true)
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(notes[0].word, "no answer")
        XCTAssertEqual(notes[0].actions, [.retry, .openTailscale, .details])
        XCTAssertTrue(notes[0].more)
    }

    func testAComputerAlsoOnNekkoCloudRelayIsNeverBlamedOnTailscale() {
        // Paired with Tailscale first and Nekko Cloud Relay as the fallback (decision 0116):
        // Tailscale being off is not what keeps it away, so no "Tailscale off" item.
        let notes = ConnectionNotes.make([facts("macbook", .offline, route: .tailscale, active: true, offTailnet: true)], tailscaleOn: false)
        XCTAssertEqual(notes.map(\.id), ["macbook"])
        XCTAssertEqual(notes[0].word, "offline")
        XCTAssertEqual(notes[0].line, "Macbook is offline.")
        XCTAssertFalse(notes[0].actions.contains(.openTailscale))

        let silent = ConnectionNotes.make([facts("macbook", .connecting, route: .tailscale, detail: "timeout", offTailnet: true)], tailscaleOn: false)
        XCTAssertEqual(silent.map(\.id), ["macbook"])
        XCTAssertEqual(silent[0].line, "Can’t reach Macbook right now.")
        XCTAssertEqual(silent[0].actions, [.retry])
    }

    func testANekkoCloudRelayRouteReachesAComputerOffTheTailnet() {
        let tailnet = "ws://mac.tail1234.ts.net:4400"
        XCTAssertTrue(Computer(id: "m", name: "Mac", relayUrl: tailnet, pairedAt: 0, alts: ["wss://nekko-agent-relay.fly.dev"]).reachableOffTailnet)
        XCTAssertFalse(Computer(id: "m", name: "Mac", relayUrl: tailnet, pairedAt: 0).reachableOffTailnet)
        XCTAssertFalse(Computer(id: "m", name: "Mac", relayUrl: tailnet, pairedAt: 0, alts: ["ws://192.168.1.20:4400"]).reachableOffTailnet,
                       "a LAN address is no use away from home")
    }

    func testOnlyTheTailnetOnlyComputerWaitsOnTailscale() {
        let notes = ConnectionNotes.make([facts("gomi", .connecting, route: .tailscale),
                                          facts("macbook", .offline, route: .tailscale, offTailnet: true)], tailscaleOn: false)
        XCTAssertEqual(notes.map(\.id), ["gomi", "macbook"])
        XCTAssertEqual(notes[0].word, "Tailscale off")
        XCTAssertEqual(notes[0].line, "Turn on Tailscale to reach Gomi.")
        XCTAssertEqual(notes[1].word, "offline")
    }

    func testARouteDenialSaysThePhoneIsLetInThroughAnotherRoute() {
        let n = ConnectionNotes.make([facts("studio", .denied, denied: .route, active: true)], tailscaleOn: true)[0]
        XCTAssertEqual(n.tone, .warning)
        XCTAssertEqual(n.word, "refused")
        XCTAssertEqual(n.line, "Studio only lets this iPhone in through another route.")
        XCTAssertEqual(n.tail, "Pair again, or change it on Studio.")
        XCTAssertEqual(n.actions, [.pairAgain, .details])
    }

    func testTheChoiceDecidesWhichRoutesAreUsedAndWhatTailscaleMeans() {
        let tailnet = "ws://mac.tail1234.ts.net:4400", lan = "ws://192.168.1.20:4400", cloud = "wss://nekko-agent-relay.fly.dev"
        var c = Computer(id: "m", name: "Mac", relayUrl: tailnet, pairedAt: 0, alts: [lan, cloud])
        XCTAssertEqual(c.routeChoice, .auto)
        XCTAssertEqual(c.routes, [lan, tailnet, cloud])
        XCTAssertTrue(c.reachableOffTailnet)
        c.routeChoice = .direct
        XCTAssertEqual(c.routes, [lan, tailnet])
        XCTAssertFalse(c.reachableOffTailnet, "chosen direct: Tailscale is what it needs")
        XCTAssertEqual(c.route, .tailscale)
        c.routeChoice = .cloud
        XCTAssertEqual(c.routes, [cloud])
        XCTAssertTrue(c.reachableOffTailnet, "chosen cloud: Tailscale never matters")
        XCTAssertEqual(c.route, .internet)
        // A kind the link never carried falls back to every route.
        var only = Computer(id: "m", name: "Mac", relayUrl: tailnet, pairedAt: 0, routeChoice: .cloud)
        XCTAssertEqual(only.routes, [tailnet])
        only.routeChoice = .auto
        XCTAssertFalse(only.hasCloudRoute)
        XCTAssertTrue(only.hasDirectRoute)
    }

    func testTwoSwitchesMapToTheChoice() {
        XCTAssertEqual(RouteChoice(tailscale: true, cloud: true), .auto)
        XCTAssertEqual(RouteChoice(tailscale: true, cloud: false), .direct)
        XCTAssertEqual(RouteChoice(tailscale: false, cloud: true), .cloud)
    }

    func testAnOldSavedComputerLoadsAsAuto() throws {
        let json = #"{"id":"old","name":"Mac","relayUrl":"wss://r.example","pairedAt":1}"#
        XCTAssertEqual(try JSONDecoder().decode(Computer.self, from: Data(json.utf8)).routeChoice, .auto)
        var c = Computer(id: "n", name: "Mac", relayUrl: "wss://r.example", pairedAt: 1)
        c.routeChoice = .cloud
        XCTAssertEqual(try JSONDecoder().decode(Computer.self, from: JSONEncoder().encode(c)).routeChoice, .cloud)
    }

    func testFirstDialSaysNothingUntilItFails() {
        let n = ConnectionNotes.make([facts("studio", .connecting, active: true)], tailscaleOn: true)[0]
        XCTAssertEqual(n.tone, .waiting)
        XCTAssertFalse(n.opens)
    }

    func testRefusedOffersOnlyPairAgain() {
        let n = ConnectionNotes.make([facts("gomi", .denied, denied: .revoked)], tailscaleOn: true)[0]
        XCTAssertEqual(n.tone, .danger)
        XCTAssertEqual(n.word, "refused")
        XCTAssertEqual(n.line, "Gomi removed this iPhone.")
        XCTAssertEqual(n.actions, [.pairAgain])
    }

    func testAChangedKeyIsNamedEvenWhileDialing() {
        let n = ConnectionNotes.make([facts("studio", .connecting, detail: RelayStatus.badPairingKey)], tailscaleOn: true)[0]
        XCTAssertEqual(n.word, "key changed")
        XCTAssertEqual(n.actions, [.pairAgain])
    }

    func testAVersionMismatchIsAWordOnAnOnlineComputer() {
        let n = ConnectionNotes.make([facts("studio", .online, active: true, check: .updateComputer)], tailscaleOn: true)[0]
        XCTAssertEqual(n.tone, .ok)
        XCTAssertEqual(n.word, "update")
        XCTAssertEqual(n.wordTone, .warning)
        XCTAssertEqual(n.line, "Studio runs an older Nekko Agent.")
        XCTAssertTrue(n.actions.isEmpty)
    }

    func testAComputerSwitchedOffIsNotAProblemAndNotBlockedByTailscale() {
        let notes = ConnectionNotes.make([facts("studio", .idle, route: .tailscale, disabled: true)], tailscaleOn: false)
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(notes[0].tone, .off)
        XCTAssertFalse(notes[0].opens)
    }

    func testASafetyExitSaysWhatThisPhoneDid() {
        var f = facts("studio", .denied, active: true)
        f.exit = .stoppedRemote
        f.exitAt = 0
        let n = ConnectionNotes.make([f], tailscaleOn: true, time: { _ in "9:40" })[0]
        XCTAssertEqual(n.word, "stopped")
        XCTAssertEqual(n.line, "You stopped remote access here at 9:40.")
        XCTAssertEqual(n.actions, [.tryAgain, .details])
    }
}
