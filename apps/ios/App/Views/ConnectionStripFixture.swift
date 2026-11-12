#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// The connection strip in each state, for screenshots. No pairing or network calls.
struct ConnectionStripFixture: View {
    @Environment(\.palette) private var palette

    private static func c(_ id: String, _ state: RelayState, route: RelayRoute = .lan, detail: String? = nil,
                          denied: DenyReason? = nil, active: Bool = false, waiting: Int = 0,
                          check: ProtocolCheck = .same) -> ConnectionFacts {
        ConnectionFacts(id: id, name: id, route: route, relayHost: "\(id.lowercased()).tail.ts.net", state: state, detail: detail,
                        denied: denied, active: active, protocolCheck: check, waiting: waiting)
    }

    var body: some View {
        NavigationStack {
            List {
                scenario("All connected", [Self.c("Studio", .online, active: true), Self.c("Gomi", .online), Self.c("Laptop", .online)])
                scenario("Tailscale off", [Self.c("Studio", .connecting, route: .tailscale, active: true, waiting: 2),
                                           Self.c("Gomi", .online), Self.c("Laptop", .offline)], tailscale: false)
                scenario("Tailscale off, opened", [Self.c("Studio", .connecting, route: .tailscale, active: true, waiting: 2),
                                                   Self.c("Gomi", .online), Self.c("Laptop", .offline)],
                         tailscale: false, open: ConnectionNote.tailscaleId)
                scenario("Tailscale on, no answer", [Self.c("Studio", .connecting, route: .tailscale, detail: "timed out", active: true),
                                                     Self.c("Gomi", .online)], open: "Studio")
                scenario("Refused", [Self.c("Studio", .online, active: true), Self.c("Gomi", .denied, denied: .revoked),
                                     Self.c("Laptop", .offline)], open: "Gomi")
                scenario("Version", [Self.c("Studio", .online, active: true, check: .updateComputer), Self.c("Gomi", .online)], open: "Studio")
            }
            .listStyle(.plain)
            .appBackground()
            .navigationTitle("Chats")
        }
    }

    private func scenario(_ title: String, _ facts: [ConnectionFacts], tailscale: Bool = true, open: String? = nil) -> some View {
        Section {
            ConnectionStrip(details: {}, facts: facts, tailscaleOn: tailscale, open: open)
                .listRowSeparator(.hidden).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
        } header: {
            Text(title).font(.caption).foregroundStyle(palette.inkFaint)
        }
        .listSectionSeparator(.hidden)
    }
}
#endif
