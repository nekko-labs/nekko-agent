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
 * into memory only (never a file), for at most [Wav.MAX_SECONDS].
 *
 * [record] runs until [stop] is called, the cap is reached, or the coroutine is
 * cancelled (then nothing is returned). The caller holds RECORD_AUDIO.
 */
class Recorder {
    @Volatile private var recording: RecordingLatch? = null

    /** Elapsed samples and the latest peak level (0..1), for the recording bar. */
    fun interface Progress {
        fun update(samples: Int, level: Float)
    }

    @SuppressLint("MissingPermission") // The composer asks for RECORD_AUDIO before calling this.
    suspend fun record(progress: Progress): ShortArray {
        // Publish before dispatching so a stop during the IO handoff is not reset or lost.
        val session = RecordingLatch()
        recording = session
        try {
            return withContext(Dispatchers.IO) {
                val context = currentCoroutineContext()
                session.withCancellation { isActive ->
                    context.ensureActive()
                    if (session.stopped) return@withCancellation ShortArray(0)
                    val minBuf = AudioRecord.getMinBufferSize(Wav.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
                    if (minBuf <= 0) throw IllegalStateException("This phone can’t record 16 kHz audio.")
                    context.ensureActive()
                    if (session.stopped) return@withCancellation ShortArray(0)
                    val rec = AudioRecord(
                        MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        Wav.SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                        maxOf(minBuf, Wav.SAMPLE_RATE / 5 * 2),
                    )
                    try {
                        context.ensureActive()
                        if (session.stopped) return@withCancellation ShortArray(0)
                        if (rec.state != AudioRecord.STATE_INITIALIZED) {
                            throw IllegalStateException("The microphone is busy or unavailable.")
                        }
                        val out = ShortArray(Wav.MAX_SAMPLES)
                        val chunk = ShortArray(Wav.SAMPLE_RATE / 10)
                        var n = 0
                        if (session.start(isActive) { rec.startRecording() }) {
                            while (!session.stopped && n < out.size && isActive()) {
                                val got = rec.read(chunk, 0, minOf(chunk.size, out.size - n))
                                if (got < 0) throw IllegalStateException("The microphone stopped (error $got).")
                                chunk.copyInto(out, n, 0, got)
                                n += got
                                progress.update(n, Wav.level(chunk, got))
                            }
                        }
                        out.copyOf(n)
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
