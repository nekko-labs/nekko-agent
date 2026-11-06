import Foundation

/// An `NSCache` keyed by string that can be shared across threads and stored in
/// a `static let`. `NSCache` is documented thread-safe, but Foundation does not
/// mark it `Sendable` everywhere (Linux), so this wrapper states the promise once,
/// backed by NSCache's own locking, and requires the values to be `Sendable`.
public final class SharedCache<Value: AnyObject & Sendable>: @unchecked Sendable {
    private let cache = NSCache<NSString, Value>()

    public init(countLimit: Int) {
        cache.countLimit = countLimit
    }

    public subscript(key: String) -> Value? {
        get { cache.object(forKey: key as NSString) }
        set {
            if let newValue { cache.setObject(newValue, forKey: key as NSString) } else { cache.removeObject(forKey: key as NSString) }
        }
    }

    public func set(_ value: Value, forKey key: String, cost: Int) {
        cache.setObject(value, forKey: key as NSString, cost: cost)
    }

    public func removeAll() { cache.removeAllObjects() }
}
