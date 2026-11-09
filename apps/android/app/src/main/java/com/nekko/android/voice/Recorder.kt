package com.nekko.android.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/** One recording's startup and stop share a lock; a stopped recording can never start again. */
internal class RecordingLatch {
    @Volatile var stopped = false
        private set

    @Synchronized
    fun stop() {
        stopped = true
    }

    @Synchronized
    fun start(isActive: () -> Boolean, startRecording: () -> Unit): Boolean {
        if (stopped || !isActive()) return false
        startRecording()
        return true
    }

    // Register before any blocking allocation. Cancellation may happen while the block is running.
    suspend fun <T> withCancellation(block: (isActive: () -> Boolean) -> T): T = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { stop() }
        continuation.resumeWith(runCatching { block { continuation.isActive } })
    }
}

/**
 * Records the microphone as 16 kHz mono 16-bit PCM, the computer's format,
 * into memory only (never a file): one clip of at most [Wav.MAX_SECONDS] ([record]),
 * or a stream of reads for continuous dictation ([stream]).
 *
 * Both run until [stop] is called (or [record]'s cap is reached) or the coroutine
 * is cancelled (then nothing more is delivered). The caller holds RECORD_AUDIO.
 */
class Recorder {
    @Volatile private var recording: RecordingLatch? = null

    /** Elapsed samples and the latest peak level (0..1), for the recording bar. */
    fun interface Progress {
        fun update(samples: Int, level: Float)
    }

    @SuppressLint("MissingPermission") // The composer asks for RECORD_AUDIO before calling this.
    suspend fun record(progress: Progress): ShortArray {
        val out = ShortArray(Wav.MAX_SAMPLES)
        var n = 0
        capture { chunk, got ->
            val take = minOf(got, out.size - n)
            chunk.copyInto(out, n, 0, take)
            n += take
            progress.update(n, Wav.level(chunk, got))
            n < out.size
        }
        return out.copyOf(n)
    }

    /**
     * Continuous dictation (the iPhone's tap mode): no cap, until [stop] or cancellation.
     * Each 100 ms read goes to [onChunk] (a copy) on the recording thread, in order.
     */
    suspend fun stream(onChunk: (ShortArray) -> Unit, progress: Progress) {
        var n = 0
        capture { chunk, got ->
            onChunk(chunk.copyOf(got))
            n += got
            progress.update(n, Wav.level(chunk, got))
            true
        }
    }

    /** Opens the microphone and hands each read to [onRead] until it returns false, [stop], or cancellation. */
    @SuppressLint("MissingPermission")
    private suspend fun capture(onRead: (chunk: ShortArray, got: Int) -> Boolean) {
        // Publish before dispatching so a stop during the IO handoff is not reset or lost.
        val session = RecordingLatch()
        recording = session
        try {
            withContext(Dispatchers.IO) {
                val context = currentCoroutineContext()
                session.withCancellation { isActive ->
                    context.ensureActive()
                    if (session.stopped) return@withCancellation
                    val minBuf = AudioRecord.getMinBufferSize(Wav.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
                    if (minBuf <= 0) throw IllegalStateException("This phone can’t record 16 kHz audio.")
                    context.ensureActive()
                    if (session.stopped) return@withCancellation
                    val rec = AudioRecord(
                        MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        Wav.SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                        maxOf(minBuf, Wav.SAMPLE_RATE / 5 * 2),
                    )
                    try {
                        context.ensureActive()
                        if (session.stopped) return@withCancellation
                        if (rec.state != AudioRecord.STATE_INITIALIZED) {
                            throw IllegalStateException("The microphone is busy or unavailable.")
                        }
                        val chunk = ShortArray(Wav.SAMPLE_RATE / 10)
                        if (session.start(isActive) { rec.startRecording() }) {
                            while (!session.stopped && isActive()) {
                                val got = rec.read(chunk, 0, chunk.size)
                                if (got < 0) throw IllegalStateException("The microphone stopped (error $got).")
                                if (!onRead(chunk, got)) break
                            }
                        }
                    } finally {
                        runCatching { rec.stop() }
                        rec.release()
                    }
                }
            }
        } finally {
            session.stop()
            if (recording === session) recording = null
        }
    }

    fun stop() {
        recording?.stop()
    }
}
