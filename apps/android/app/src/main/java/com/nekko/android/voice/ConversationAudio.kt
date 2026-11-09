package com.nekko.android.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Foreground system audio for hands-free voice, independent of legacy one-shot dictation.
 * Main-thread API. Android 12+ dedicated on-device recognition ONLY, never an offline preference hint.
 * Own one instance per voice sheet and close it on disposal. No background service or file storage.
 */
class ConversationAudio(context: Context, private val interrupted: () -> Unit) : AutoCloseable {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val audioManager = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener({ change -> if (change < 0) { stop(); interrupted() } }, main)
        .build()
    private var focused = false
    private var closed = false
    private var recognition: Recognition? = null
    private var speaker: TextToSpeech? = null
    private var initializing: CancellableContinuation<Unit>? = null
    private var speaking: CancellableContinuation<Unit>? = null
    private var utterance: String? = null

    private class Recognition(val recognizer: SpeechRecognizer, val continuation: CancellableContinuation<String>)

    fun available(): Boolean = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(app)

    private fun requireMain() { check(Looper.myLooper() == Looper.getMainLooper()) { "Voice audio must run on Main." } }
    private fun acquireFocus() {
        requireMain()
        check(!closed) { "Voice audio is closed." }
        if (!focused) {
            check(audioManager.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Audio is busy. Tap Start when the call or other audio finishes." }
            focused = true
        }
    }

    /** Each final result is an utterance boundary. Never sends partial recognition results. */
    suspend fun capture(language: String = "", onLevel: (Float) -> Unit = {}, onReady: () -> Unit = {}): String {
        requireMain()
        if (Build.VERSION.SDK_INT < 31 || !available()) {
            throw IllegalStateException("On-device speech recognition is unavailable. Install speech support on this phone, or use dictation on your computer.")
        }
        check(app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { "Allow microphone access in Settings → Apps → Nekko Agent → Permissions." }
        check(recognition == null && speaking == null) { "Voice audio is already in use." }
        acquireFocus()
        return suspendCancellableCoroutine { cont ->
            val sr = SpeechRecognizer.createOnDeviceSpeechRecognizer(app)
            val run = Recognition(sr, cont)
            recognition = run
            fun finish(text: String? = null, error: Exception? = null) {
                if (recognition !== run) return
                recognition = null
                runCatching { sr.cancel() }; runCatching { sr.destroy() }
                if (cont.isActive) {
                    if (error != null) cont.resumeWithException(error) else cont.resume(text.orEmpty())
                }
            }
            sr.setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle) = finish(results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty())
                override fun onError(error: Int) {
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) finish("")
                    else finish(error = IllegalStateException(when (error) {
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Allow microphone access in the phone's app settings."
                        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "On-device speech for this language is not installed. Install it in the phone's speech settings."
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "The microphone is busy. Stop other dictation and tap Start again."
                        else -> "On-device recognition stopped (error $error). Tap Start to try again."
                    }))
                }
                override fun onRmsChanged(rmsdB: Float) { if (recognition === run && cont.isActive) onLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f)) }
                override fun onReadyForSpeech(params: Bundle?) { if (recognition === run && cont.isActive) onReady() }
                override fun onBeginningOfSpeech() = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit
                override fun onPartialResults(partialResults: Bundle?) = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
            cont.invokeOnCancellation {
                onMain {
                    // A posted cancellation belongs to this recognizer, not whichever one started later.
                    if (recognition === run) { recognition = null; runCatching { sr.cancel() }; runCatching { sr.destroy() } }
                }
            }
            try {
                if (cont.isActive) sr.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                    if (language.isNotBlank()) putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                })
            } catch (e: Exception) { finish(error = e) }
        }
    }

    private suspend fun prepareSpeaker() {
        if (speaker != null && initializing == null) return
        check(initializing == null) { "Speech output is already starting." }
        suspendCancellableCoroutine<Unit> { cont ->
            initializing = cont
            var created: TextToSpeech? = null
            created = TextToSpeech(app) { status ->
                main.post {
                    if (initializing !== cont || !cont.isActive) return@post
                    initializing = null
                    if (status == TextToSpeech.SUCCESS && created != null) cont.resume(Unit)
                    else {
                        if (speaker === created) speaker = null
                        created?.shutdown()
                        cont.resumeWithException(IllegalStateException("Speech output is unavailable. Install an offline voice in Android's text-to-speech settings."))
                    }
                }
            }
            speaker = created
            cont.invokeOnCancellation { onMain {
                if (initializing === cont) { initializing = null; if (speaker === created) speaker = null; created?.shutdown() }
            } }
        }
    }

    suspend fun speak(text: String, language: String = "") {
        requireMain()
        check(recognition == null && speaking == null) { "Voice audio is already in use." }
        acquireFocus()
        prepareSpeaker()
        val tts = checkNotNull(speaker)
        val locale = if (language.isBlank()) Locale.getDefault() else Locale.forLanguageTag(language)
        val voices = tts.voices.orEmpty().filter {
            !it.isNetworkConnectionRequired && it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true && it.locale.language == locale.language
        }
        val selected = voices.firstOrNull { it.locale.toLanguageTag() == locale.toLanguageTag() } ?: voices.firstOrNull()
        check(selected != null) { "No installed offline voice for ${locale.displayLanguage}. Install one in Android's text-to-speech settings." }
        check(tts.setVoice(selected) == TextToSpeech.SUCCESS) { "The offline voice could not start." }
        for (chunk in VoiceSpeech.chunks(text, TextToSpeech.getMaxSpeechInputLength())) {
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            speakChunk(tts, chunk)
        }
    }

    private suspend fun speakChunk(tts: TextToSpeech, text: String) {
        suspendCancellableCoroutine<Unit> { cont ->
            val id = UUID.randomUUID().toString()
            speaking = cont
            utterance = id
            fun finish(error: String? = null) { onMain {
                if (utterance == id && speaking === cont) {
                    utterance = null; speaking = null
                    if (cont.isActive) {
                        if (error == null) cont.resume(Unit) else cont.resumeWithException(IllegalStateException(error))
                    }
                }
            } }
            tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit
                override fun onDone(utteranceId: String?) { if (utteranceId == id) finish() }
                @Deprecated("Android legacy callback")
                override fun onError(utteranceId: String?) { if (utteranceId == id) finish("Speech output stopped. Check the chat before continuing.") }
                override fun onStop(utteranceId: String?, interrupted: Boolean) { if (utteranceId == id) finish("Speech output was interrupted. Tap Start to continue.") }
            })
            cont.invokeOnCancellation { onMain {
                if (utterance == id && speaking === cont) { utterance = null; speaking = null; tts.stop() }
            } }
            if (cont.isActive && tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) == TextToSpeech.ERROR) finish("The offline voice could not read this reply.")
        }
    }

    /** Delivers final words to the command runner on normal hold release, NOT for safety exits. */
    fun finishCapture() { requireMain(); recognition?.recognizer?.stopListening() }

    /** Stop is immediate cancellation, not stopListening (which would deliver and send the last words). */
    fun stop() {
        requireMain()
        val old = recognition
        recognition = null
        old?.continuation?.cancel()
        old?.recognizer?.let { runCatching { it.cancel() }; runCatching { it.destroy() } }
        val init = initializing
        initializing = null
        init?.cancel()
        if (init != null) { speaker?.shutdown(); speaker = null }
        val speech = speaking
        speaking = null; utterance = null
        speech?.cancel()
        speaker?.stop()
        if (focused) { focused = false; audioManager.abandonAudioFocusRequest(focus) }
    }

    override fun close() { requireMain(); stop(); closed = true; speaker?.shutdown(); speaker = null }
    private fun onMain(work: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) work() else main.post { work() } }
}
