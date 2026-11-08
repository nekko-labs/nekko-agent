package com.nekko.android.voice

import kotlin.math.sqrt

/** iOS/desktop PCM segmentation rules. Chunk boundaries do not affect the 100 ms analysis blocks. */
class VoiceSegmenter(
    private val sampleRate: Int,
    silenceSeconds: Double = 1.2,
    maxSeconds: Double = 30.0,
    private val threshold: Float = 0.015f,
) {
    init {
        require(sampleRate > 0)
        require(silenceSeconds.isFinite() && maxSeconds.isFinite() && maxSeconds > 0)
        require(threshold.isFinite() && threshold >= 0)
    }
    private val silenceSamples = (silenceSeconds.coerceIn(0.3, 5.0) * sampleRate).toInt()
    private val maxSamples = (maxSeconds * sampleRate).toInt().coerceAtLeast(1)
    private val blockSize = (sampleRate / 10).coerceAtLeast(1)
    private val buffer = ArrayList<Float>()
    private val pending = ArrayList<Float>()
    private var firstVoiced: Int? = null
    private var lastVoicedEnd = 0
    private var silent = 0

    /** Returns one segment. Feed an empty array or call flush repeatedly to drain additional segments. */
    fun feed(samples: FloatArray): FloatArray? { samples.forEach { pending.add(it) }; return drain(false) }
    fun feed(samples: ShortArray): FloatArray? = feed(FloatArray(samples.size) { samples[it] / 32768f })

    fun flush(): FloatArray? {
        drain(true)?.let { return it }
        val segment = if (keepable()) buffer.toFloatArray() else null
        reset()
        return segment
    }

    fun discard() { pending.clear(); reset() }
    private fun keepable() = firstVoiced?.let { (lastVoicedEnd - it).toDouble() / sampleRate >= MIN_SPEECH_SECONDS } ?: false
    private fun reset() { buffer.clear(); firstVoiced = null; lastVoicedEnd = 0; silent = 0 }

    private fun drain(final: Boolean): FloatArray? {
        var offset = 0
        try {
            while (offset < pending.size) {
                val end = minOf(offset + blockSize, pending.size)
                if (end - offset < blockSize && !final) break
                var squares = 0.0
                for (i in offset until end) { val s = pending[i]; squares += s * s; buffer.add(s) }
                val count = end - offset
                offset = end
                if (sqrt(squares / count) > threshold) {
                    if (firstVoiced == null) firstVoiced = buffer.size - count
                    lastVoicedEnd = buffer.size
                    silent = 0
                } else silent += count
                if (firstVoiced == null) {
                    val keep = (PRE_ROLL_SECONDS * sampleRate).toInt()
                    if (buffer.size > keep) buffer.subList(0, buffer.size - keep).clear()
                    continue
                }
                if (silent > silenceSamples || buffer.size >= maxSamples) {
                    val segment = if (keepable()) buffer.toFloatArray() else null
                    reset()
                    if (segment != null) return segment
                }
            }
            return null
        } finally { if (offset > 0) pending.subList(0, offset).clear() }
    }

    companion object {
        const val PRE_ROLL_SECONDS = 0.3
        const val MIN_SPEECH_SECONDS = 0.25
    }
}
