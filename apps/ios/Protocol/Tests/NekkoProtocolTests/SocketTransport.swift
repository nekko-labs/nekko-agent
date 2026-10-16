#if os(Linux)
import Foundation
import Glibc
@testable import NekkoProtocol

/// A tiny RFC 6455 client over a POSIX socket, `ws://` only, for running the
/// live integration test on Linux, where FoundationNetworking's libcurl has no
/// WebSocket support. The app always uses `URLSessionTransport`; macOS CI runs
/// the same test over it.
struct SocketTransport: WsTransport {
    func open(url: URL, handlers: WsHandlers) throws -> WsConnection {
        guard url.scheme == "ws", let host = url.host, let port = url.port else { throw RelayError("ws://host:port only") }
        return SocketConnection(host: host, port: port, path: url.path + (url.query.map { "?" + $0 } ?? ""), handlers: handlers)
    }
}

final class SocketConnection: WsConnection, @unchecked Sendable {
    let host: String
    let port: Int
    let path: String
    let handlers: WsHandlers
    private let lock = NSLock()
    private var fd: Int32 = -1
    private var open = false
    private var closed = false

    init(host: String, port: Int, path: String, handlers: WsHandlers) {
        self.host = host
        self.port = port
        self.path = path
        self.handlers = handlers
    }

    func start() {
        Thread.detachNewThread { self.run() }
    }

    private func run() {
        let s = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        inet_pton(AF_INET, host == "localhost" ? "127.0.0.1" : host, &addr.sin_addr)
        let ok = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard ok == 0 else { finish(1006, "connect failed"); return }
        lock.lock(); fd = s; lock.unlock()
        let key = E2E.randomBytes(16).base64EncodedString()
        let req = "GET \(path) HTTP/1.1\r\nHost: \(host):\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n"
        guard write(Data(req.utf8)) else { finish(1006, "write failed"); return }
        var buf = Data()
        while buf.range(of: Data("\r\n\r\n".utf8)) == nil {
            guard let chunk = read() else { finish(1006, "handshake failed"); return }
            buf.append(chunk)
        }
        let end = buf.range(of: Data("\r\n\r\n".utf8))!
        let head = String(decoding: buf[..<end.lowerBound], as: UTF8.self)
        guard head.hasPrefix("HTTP/1.1 101") else { finish(1006, head.components(separatedBy: "\r\n").first ?? "refused"); return }
        buf = Data(buf[end.upperBound...])
        lock.lock(); open = true; lock.unlock()
        handlers.onOpen()
        var message = Data()
        while true {
            while let (fin, op, payload, used) = Self.parse(buf) {
                buf = Data(buf.dropFirst(used))
                switch op {
                case 0x1, 0x0:
                    message.append(payload)
                    if fin {
                        handlers.onMessage(String(decoding: message, as: UTF8.self))
                        message = Data()
                    }
                case 0x8:
                    let code = payload.count >= 2 ? Int(payload[payload.startIndex]) << 8 | Int(payload[payload.startIndex + 1]) : 1005
                    let reason = payload.count > 2 ? String(decoding: payload.dropFirst(2), as: UTF8.self) : ""
                    finish(code, reason)
                    return
                case 0x9:
                    _ = sendFrame(0xA, payload)
                default:
                    break
                }
            }
            guard let chunk = read() else { finish(1006, "connection lost"); return }
            buf.append(chunk)
        }
    }

    /// (fin, opcode, payload, bytes used) for one complete unmasked server frame.
    static func parse(_ b: Data) -> (Bool, UInt8, Data, Int)? {
        let a = [UInt8](b.prefix(14))
        guard a.count >= 2 else { return nil }
        var len = Int(a[1] & 0x7f)
        var off = 2
        if len == 126 {
            guard a.count >= 4 else { return nil }
            len = Int(a[2]) << 8 | Int(a[3]); off = 4
        } else if len == 127 {
            guard a.count >= 10 else { return nil }
            len = (2..<10).reduce(0) { $0 << 8 | Int(a[$1]) }; off = 10
        }
        guard b.count >= off + len else { return nil }
        let start = b.startIndex + off
        return (a[0] & 0x80 != 0, a[0] & 0x0f, Data(b[start..<start + len]), off + len)
    }

    private func sendFrame(_ op: UInt8, _ payload: Data) -> Bool {
        var f = Data([0x80 | op])
        let n = payload.count
        if n < 126 { f.append(UInt8(n) | 0x80) } else if n < 65536 { f.append(contentsOf: [UInt8(126 | 0x80), UInt8(n >> 8), UInt8(n & 0xff)]) } else {
            f.append(127 | 0x80)
            for i in (0..<8).reversed() { f.append(UInt8((n >> (8 * i)) & 0xff)) }
        }
        let mask = [UInt8](E2E.randomBytes(4))
        f.append(contentsOf: mask)
        f.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
        return write(f)
    }

    func send(_ text: String) -> Bool {
        lock.lock(); let ready = open && !closed; lock.unlock()
        return ready && sendFrame(0x1, Data(text.utf8))
    }

    func close(code: Int, reason: String) {
        lock.lock(); let ready = open && !closed; lock.unlock()
        if ready { _ = sendFrame(0x8, Data([UInt8(code >> 8), UInt8(code & 0xff)]) + Data(reason.utf8)) }
        finish(code, reason)
    }

    private func write(_ d: Data) -> Bool {
        lock.lock(); let s = fd; lock.unlock()
        guard s >= 0 else { return false }
        return d.withUnsafeBytes { p -> Bool in
            var sent = 0
            while sent < d.count {
                let n = Glibc.send(s, p.baseAddress! + sent, d.count - sent, Int32(MSG_NOSIGNAL))
                if n <= 0 { return false }
                sent += n
            }
            return true
        }
    }

    private func read() -> Data? {
        lock.lock(); let s = fd; lock.unlock()
        guard s >= 0 else { return nil }
        var tmp = [UInt8](repeating: 0, count: 65536)
        let n = recv(s, &tmp, tmp.count, 0)
        return n > 0 ? Data(tmp[0..<n]) : nil
    }

    private func finish(_ code: Int, _ reason: String) {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        let s = fd
        fd = -1
        lock.unlock()
        if s >= 0 { shutdown(s, Int32(SHUT_RDWR)); Glibc.close(s) }
        handlers.onClosed(code, reason)
    }
}
#endif
