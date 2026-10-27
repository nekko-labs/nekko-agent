import Foundation

/// Cuts a live mic stream into utterances for transcription. The iOS twin of the desktop
/// rules in apps/desktop/src/renderer/voiceCapture.ts (shouldCut, keepSegment, trimPreRoll).
/// Feed it any size of chunk: it works in 0.1 s blocks, so the cut points do not depend on the chunking.
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
    /// segments the rest is kept and handled by the next call.
    public mutating func feed(_ samples: [Float]) -> [Float]? {
        let input = pending + samples
        pending = []
        let block = max(1, Int(sampleRate / 10))
        var i = 0
        while i < input.count {
            let end = min(i + block, input.count)
            let chunk = input[i..<end]
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
            let kept = Double(lastVoicedEnd - (firstVoiced ?? 0)) / sampleRate >= Self.minSpeechSeconds
            let segment = buffer
            buffer = []; firstVoiced = nil; lastVoicedEnd = 0; silent = 0
            if kept {
                pending = Array(input[i...])
                return segment
            }
        }
        return nil
    }
}
