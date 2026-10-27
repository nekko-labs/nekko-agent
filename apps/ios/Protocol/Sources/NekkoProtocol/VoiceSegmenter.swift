import Foundation

/// Cuts a live mic stream into utterances for transcription. The iOS twin of the desktop
/// rules in apps/desktop/src/renderer/voiceCapture.ts (shouldCut, keepSegment, trimPreRoll).
/// Feed it any size of chunk: it works in 0.1 s blocks (a partial block waits for the next feed), so the cut points do not depend on the chunking.
public struct VoiceSegmenter {
    public static let preRollSeconds = 0.3
    public static let minSpeechSeconds = 0.25

    private let sampleRate: Double
    private let silenceSamples: Int
    private let maxSamples: Int
    private let threshold: Float
    private var buffer: [Float] = []
    private var pending: [Float] = []
    private var firstVoiced: Int?
    private var lastVoicedEnd = 0
    private var silent = 0

    /// `silenceSeconds` is clamped to 0.3...5, as on the desktop.
    public init(sampleRate: Double, silenceSeconds: Double, maxSeconds: Double = 30, threshold: Float) {
        self.sampleRate = sampleRate
        silenceSamples = Int(max(0.3, min(5, silenceSeconds)) * sampleRate)
        maxSamples = Int(maxSeconds * sampleRate)
        self.threshold = threshold
    }

    /// A finished segment's samples after silence follows speech or the segment reaches `maxSeconds`;
    /// nil otherwise. A segment with under 0.25 s of speech is dropped. If one call holds several
    /// segments the rest waits in the segmenter: call `flush` when capture stops to drain it.
    public mutating func feed(_ samples: [Float]) -> [Float]? {
        pending += samples
        return drain(final: false)
    }

    /// Call when capture stops. Returns the next waiting segment, or the utterance in progress if it
    /// holds 0.25 s of speech; call again until nil. Returning nil leaves the segmenter reset.
    public mutating func flush() -> [Float]? {
        if let segment = drain(final: true) { return segment }
        let segment = isKeepable ? buffer : nil
        reset()
        return segment
    }

    private var isKeepable: Bool {
        guard let first = firstVoiced else { return false }
        return Double(lastVoicedEnd - first) / sampleRate >= Self.minSpeechSeconds
    }

    private mutating func reset() { buffer = []; firstVoiced = nil; lastVoicedEnd = 0; silent = 0 }

    /// Works in 0.1 s blocks; a partial trailing block waits for more samples unless `final`.
    private mutating func drain(final: Bool) -> [Float]? {
        let block = max(1, Int(sampleRate / 10))
        var i = 0
        defer { pending.removeFirst(i) }
        while i < pending.count {
            let end = min(i + block, pending.count)
            if end - i < block && !final { break }
            let chunk = pending[i..<end]
            i = end
            let rms = (chunk.reduce(0) { $0 + $1 * $1 } / Float(chunk.count)).squareRoot()
            buffer += chunk
            if rms > threshold {
                firstVoiced = firstVoiced ?? buffer.count - chunk.count
                lastVoicedEnd = buffer.count
                silent = 0
            } else {
                silent += chunk.count
            }
            if firstVoiced == nil {
                // Before speech keep just enough recent audio to catch the first syllable.
                let keep = Int(Self.preRollSeconds * sampleRate)
                if buffer.count > keep { buffer.removeFirst(buffer.count - keep) }
                continue
            }
            guard silent > silenceSamples || buffer.count >= maxSamples else { continue }
            let segment = isKeepable ? buffer : nil
            reset()
            if let segment { return segment }
        }
        return nil
    }
}
