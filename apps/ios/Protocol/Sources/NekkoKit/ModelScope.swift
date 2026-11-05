import NekkoProtocol

/// The tabs across the top of the model pickers, after the desktop's "Model source"
/// group (ModelPicker.tsx): every model, the cloud APIs only, or the model servers
/// on a computer only. The desktop's fourth tab, Fusion, is Auto routing, which the
/// phone does not offer. All is where a picker opens, as on the desktop.
public enum ModelScope: String, CaseIterable, Sendable, Identifiable {
    case all, cloud, local

    public var id: String { rawValue }

    /// Whether a provider of this locality is listed under the tab.
    public func includes(isLocal: Bool) -> Bool {
        switch self {
        case .all: true
        case .cloud: !isLocal
        case .local: isLocal
        }
    }

    public func includes(_ provider: PublicProvider) -> Bool { includes(isLocal: provider.isLocal) }

    /// A provider this iPhone calls itself is always a cloud API (`PhoneProviders`).
    public func includes(_ provider: PhoneProvider) -> Bool { includes(isLocal: false) }

    /// The computer's provider groups this tab lists, in their order.
    public func groups(_ groups: [ModelGroup]) -> [ModelGroup] { groups.filter { includes($0.provider) } }

    /// The starred `provider::model` keys whose provider is on, and in this tab.
    public func favorites(_ keys: [String], providers: [PublicProvider]) -> [String] {
        keys.filter { key in providers.contains { $0.enabled && includes($0) && key.hasPrefix($0.id + "::") } }
    }
}
