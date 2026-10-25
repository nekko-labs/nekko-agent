import Foundation

/// Validates host paths without resolving them against the phone's file system.
public enum WorkspacePath {
    public static func isAbsolute(_ path: String) -> Bool {
        guard !path.isEmpty, !path.contains("\0"), !path.contains("\n"), !path.contains("\r") else { return false }
        if path.hasPrefix("/") { return true }
        let chars = Array(path)
        if chars.count >= 3, chars[0].isASCII, chars[0].isLetter,
           chars[1] == ":", chars[2] == "\\" || chars[2] == "/" { return true }
        // UNC paths need both a server and share, not a drive-relative path.
        return path.hasPrefix("\\\\") && path.dropFirst(2).split(separator: "\\").count >= 2
    }
}
