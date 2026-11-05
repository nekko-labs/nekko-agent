import Foundation

/// A whole-app completeness claim, never a subset for one relay endpoint.
public enum PushBadgeManifest {
    public static func rooms(routes: [String], rooms: [String], needsYou: Bool) -> [String]? {
        let endpoints = Set(routes.compactMap { route -> String? in
            guard var url = URLComponents(string: route), url.host != nil else { return nil }
            url.host = url.host?.lowercased()
            url.scheme = url.scheme?.lowercased()
            if url.path == "/" { url.path = "" }
            return url.string
        })
        guard !routes.isEmpty, endpoints.count == 1,
              routes.allSatisfy({ URLComponents(string: $0)?.host != nil }),
              rooms.count <= 64, rooms.allSatisfy({ !$0.isEmpty && $0.count <= 256 }) else { return nil }
        return needsYou ? Set(rooms).sorted() : []
    }
}
