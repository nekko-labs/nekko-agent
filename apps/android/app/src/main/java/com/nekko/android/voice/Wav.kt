package com.nekko.android.voice

/**
 * The recording format the computer's Nekko Voice accepts (`validate_wav` in
 * crates/nekkod/src/voice.rs):
 * a 44-byte RIFF header, PCM, mono, 16 kHz, 16-bit little-endian, at most 60 s.
 */
object Wav {
    const val SAMPLE_RATE = 16_000
    const val HEADER = 44

    /** The computer's own ceiling. */
    const val COMPUTER_MAX_SECONDS = 60

    /**
     * What the phone records at most. The wire sends the WAV as a JSON array of
     * numbers, sealed and base64'd: about 150 KB per second, so 30 s is ~4.6 MB,
     * well under the relay's 10 MB frame limit (apps/relay-server/src/server.ts), where
     * 60 s (~9.1 MB) would sit right at it.
     */
    const val MAX_SECONDS = 30
    const val MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS

    /** Shorter than this is a tap, not speech. */
    const val MIN_SAMPLES = SAMPLE_RATE / 4

    /** A WAV file of [samples] (16-bit PCM, mono, 16 kHz). */
    fun encode(samples: ShortArray, count: Int = samples.size): ByteArray {
        val n = count.coerceIn(0, samples.size)
        val dataBytes = n * 2
        val out = ByteArray(HEADER + dataBytes)
        fun ascii(at: Int, s: String) = s.forEachIndexed { i, c -> out[at + i] = c.code.toByte() }
        fun u16(at: Int, v: Int) { out[at] = v.toByte(); out[at + 1] = (v shr 8).toByte() }
        fun u32(at: Int, v: Int) { u16(at, v and 0xFFFF); u16(at + 2, v ushr 16) }
        ascii(0, "RIFF"); u32(4, 36 + dataBytes); ascii(8, "WAVE")
        ascii(12, "fmt "); u32(16, 16); u16(20, 1); u16(22, 1)
        u32(24, SAMPLE_RATE); u32(28, SAMPLE_RATE * 2); u16(32, 2); u16(34, 16)
        ascii(36, "data"); u32(40, dataBytes)
        for (i in 0 until n) u16(HEADER + i * 2, samples[i].toInt())
        return out
    }

    /** Peak level 0..1 of a buffer, for the recording indicator. */
    fun level(samples: ShortArray, count: Int): Float {
        var peak = 0
        for (i in 0 until count.coerceAtMost(samples.size)) {
            val v = kotlin.math.abs(samples[i].toInt())
            if (v > peak) peak = v
        }
        return (peak / 32768f).coerceIn(0f, 1f)
    }
}
