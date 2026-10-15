package com.nekko.android.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

/**
 * Records the microphone as 16 kHz mono 16-bit PCM, the computer's format,
 * into memory only (never a file), for at most [Wav.MAX_SECONDS].
 *
 * [record] runs until [stop] is called, the cap is reached, or the coroutine is
 * cancelled (then nothing is returned). The caller holds RECORD_AUDIO.
 */
class Recorder {
    @Volatile private var stopping = false

    /** Elapsed samples and the latest peak level (0..1), for the recording bar. */
    fun interface Progress {
        fun update(samples: Int, level: Float)
    }

    @SuppressLint("MissingPermission") // The composer asks for RECORD_AUDIO before calling this.
    suspend fun record(progress: Progress): ShortArray = withContext(Dispatchers.IO) {
        stopping = false
        val minBuf = AudioRecord.getMinBufferSize(Wav.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) throw IllegalStateException("This phone can’t record 16 kHz audio.")
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            Wav.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(minBuf, Wav.SAMPLE_RATE / 5 * 2),
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            throw IllegalStateException("The microphone is busy or unavailable.")
        }
        val out = ShortArray(Wav.MAX_SAMPLES)
        var n = 0
        val chunk = ShortArray(Wav.SAMPLE_RATE / 10)
        try {
            rec.startRecording()
            while (!stopping && n < out.size && currentCoroutineContext().isActive) {
                val got = rec.read(chunk, 0, minOf(chunk.size, out.size - n))
                if (got < 0) throw IllegalStateException("The microphone stopped (error $got).")
                chunk.copyInto(out, n, 0, got)
                n += got
                progress.update(n, Wav.level(chunk, got))
            }
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
        out.copyOf(n)
    }

    fun stop() {
        stopping = true
    }
}
