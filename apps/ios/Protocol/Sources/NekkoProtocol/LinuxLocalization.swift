#if os(Linux)
// Linux Foundation does not provide Apple's String(localized:) initializer.
// Protocol and app-state tests use the source text, including interpolation.
// Keep this public so NekkoKit can use it through its NekkoProtocol import.
extension String {
    public init(localized value: String) {
        self = value
    }
}
#endif
