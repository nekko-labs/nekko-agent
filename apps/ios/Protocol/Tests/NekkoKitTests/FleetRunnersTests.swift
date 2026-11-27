import NekkoKit
import NekkoProtocol
import XCTest

final class FleetRunnersTests: XCTestCase {
    func testReadsTheFleetAndWordsEachRunnerLikeTheDesktop() throws {
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"orgs":[{"orgName":"Nekko Labs","computers":[
          {"deviceId":"d1","name":"Studio","online":true,"you":true,"runners":[
            {"label":"nekko-cloud-mac","state":"running","busy":1,"slots":2},
            {"label":"mini","state":"ready","busy":0,"slots":1},
            {"label":"old","state":"error","busy":0,"slots":0}]},
          {"deviceId":"d2","name":"Laptop","online":false,"runners":[{"label":"lap","state":"ready","busy":0,"slots":2}]},
          {"deviceId":"d3","name":"No runners","online":true,"runners":[]},
          {"name":"No id","online":true,"runners":[{"label":"x","state":"ready","busy":0,"slots":1}]}]}]}
        """.utf8))
        let list = FleetRunnerComputer.list(raw)
        XCTAssertEqual(list.map(\.name), ["Studio", "Laptop"])
        XCTAssertEqual(list[0].org, "Nekko Labs")
        XCTAssertTrue(list[0].you)
        XCTAssertEqual(list[0].lines, [
            "CI runner nekko-cloud-mac: running a job (1 of 2 VMs)",
            "CI runner mini: ready (1 VM)",
            "CI runner old: needs attention",
        ])
        XCTAssertEqual(list[1].lines, [], "an offline Mac's runner state is stale")
        XCTAssertEqual(FleetRunnerComputer.list(.null), [])
    }
}
