package com.nekko.android.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Android's own speech recognizer, for when the computer can't transcribe.
 * Asks for on-device recognition; whether audio leaves the phone depends on
 * the phone (often Google's servers), which Settings → Dictation says.
 * Main thread only, as SpeechRecognizer requires.
 */
class PhoneRecognizer(private val context: Context) {
    private var current: SpeechRecognizer? = null

    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    /** Listens until the user pauses, then returns what was said. [onLevel] gets 0..1 while listening. */
    suspend fun listen(language: String, onLevel: (Float) -> Unit): String = suspendCancellableCoroutine { cont ->
        val sr = SpeechRecognizer.createSpeechRecognizer(context)
        current = sr
        fun done() {
            current = null
            sr.destroy()
        }
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle) {
                val text = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                done()
                if (cont.isActive) cont.resume(text)
            }

            override fun onError(error: Int) {
                done()
                if (!cont.isActive) return
                if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) cont.resume("")
                else cont.resumeWithException(IllegalStateException(message(error)))
            }

            override fun onRmsChanged(rmsdB: Float) = onLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onPartialResults(partialResults: Bundle?) = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            if (language.isNotBlank()) putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
        }
        cont.invokeOnCancellation { runCatching { sr.cancel(); sr.destroy() } }
        sr.startListening(intent)
    }

    /** End listening now; [listen] still returns what it heard. */
    fun stop() {
        current?.stopListening()
    }

    private fun message(error: Int) = when (error) {
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "The phone’s speech recognizer needs a connection."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Nekko needs the microphone permission."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "The phone’s speech recognizer is busy. Try again."
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "That language isn’t available on this phone."
        else -> "The phone’s speech recognizer stopped (error $error)."
    }
}
