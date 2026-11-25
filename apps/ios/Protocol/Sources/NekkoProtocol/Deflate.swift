import Foundation
#if canImport(Compression)
import Compression
#endif

/// Raw deflate (RFC 1951, no zlib header or checksum) for compressed sync records
/// (decision 0121). Apple's `COMPRESSION_ZLIB` is raw deflate, the same stream
/// `flate2::DeflateEncoder` makes on the computer. The checksum is not needed:
/// the record is authenticated by AES-GCM around it.
///
/// Compression is only available where the Compression framework is (every Apple
/// platform). The Linux build of the protocol tests has neither, so there inflate
/// refuses and `compress` returns nil, which seals a record uncompressed.
enum Deflate {
    /// The most plaintext a record opens to; see `SyncCrypto.maxPlaintext`.
    static let chunk = 64 * 1024

    #if canImport(Compression)
    static let available = true

    /// Deflate `input`. Nil if it cannot be done.
    static func compress(_ input: Data) -> Data? {
        try? run(input, encode: true, limit: nil)
    }

    /// Inflate `input`, throwing `.malformed` for a stream that is cut short, is not deflate, or
    /// would inflate to more than `limit` bytes. Output is checked as it is produced.
    static func inflate(_ input: Data, limit: Int) throws -> Data {
        try run(input, encode: false, limit: limit)
    }

    private static func run(_ input: Data, encode: Bool, limit: Int?) throws -> Data {
        guard !input.isEmpty else { throw SyncCrypto.Failure.malformed }
        let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { dst.deallocate() }
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        let op = encode ? COMPRESSION_STREAM_ENCODE : COMPRESSION_STREAM_DECODE
        guard compression_stream_init(stream, op, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw SyncCrypto.Failure.malformed
        }
        defer { compression_stream_destroy(stream) }
        var out = Data()
        return try input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Data in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { throw SyncCrypto.Failure.malformed }
            stream.pointee.src_ptr = base
            stream.pointee.src_size = input.count
            stream.pointee.dst_ptr = dst
            stream.pointee.dst_size = chunk
            while true {
                let before = stream.pointee.src_size
                let status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                guard status == COMPRESSION_STATUS_OK || status == COMPRESSION_STATUS_END else { throw SyncCrypto.Failure.malformed }
                let produced = chunk - stream.pointee.dst_size
                out.append(dst, count: produced)
                if let limit, out.count > limit { throw SyncCrypto.Failure.malformed }
                if status == COMPRESSION_STATUS_END { return out }
                // No input used and no output made: a cut-short stream would loop forever.
                if produced == 0 && stream.pointee.src_size == before { throw SyncCrypto.Failure.malformed }
                stream.pointee.dst_ptr = dst
                stream.pointee.dst_size = chunk
            }
        }
    }
    #else
    static let available = false
    static func compress(_ input: Data) -> Data? { nil }
    static func inflate(_ input: Data, limit: Int) throws -> Data { throw SyncCrypto.Failure.malformed }
    #endif
}
