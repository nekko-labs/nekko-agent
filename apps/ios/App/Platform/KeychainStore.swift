import Foundation
import NekkoKit
import Security

/// Pairing material in the Keychain: this device only, after first unlock (so
/// a background push or Live Activity button can reconnect while locked), never
/// synced to iCloud or restored to another phone.
final class KeychainStore: SecureStore, @unchecked Sendable {
    private let service: String

    init(service: String = "com.nekko.native.ios.pairing") { self.service = service }

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key,
         kSecAttrSynchronizable as String: false]
    }

    func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(_ key: String, _ value: String?) {
        guard let value else {
            SecItemDelete(query(key) as CFDictionary)
            return
        }
        let attrs: [String: Any] = [kSecValueData as String: Data(value.utf8),
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query(key) as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var item = query(key)
            attrs.forEach { item[$0.key] = $0.value }
            SecItemAdd(item as CFDictionary, nil)
        }
    }

    /// Everything this app stored (Settings → Forget all computers).
    func wipe() {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(q as CFDictionary)
    }
}
