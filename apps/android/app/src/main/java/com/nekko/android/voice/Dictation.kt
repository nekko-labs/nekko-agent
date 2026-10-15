package com.nekko.android.voice

import com.nekko.android.data.PhonePrefs

/** Where the speech turns into text. */
enum class Engine {
    /** Whisper on the paired computer, through the encrypted relay. The audio never reaches a third party. */
    COMPUTER,

    /** Android's speech recognizer (often Google's servers, unless the phone does it on-device). */
    PHONE,
}

/** Settings → Dictation: which engine to use. */
enum class EngineChoice {
    /** The computer's Whisper when it is installed and on, else the phone. The default. */
    COMPUTER_FIRST,

    /** Only the computer; dictation is unavailable when it can't transcribe. */
    COMPUTER_ONLY,

    /** Always the phone's recognizer. */
    PHONE,
}

/** What the computer said about its Nekko Voice (`voice:status` plus `settings.voice.enabled`). */
data class ComputerVoice(val online: Boolean, val installed: Boolean, val enabled: Boolean) {
    val ready: Boolean get() = online && installed && enabled

    /** Why the computer can't transcribe right now, for the user. */
    fun whyNot(name: String): String = when {
        !online -> "$name is offline."
        !installed -> "Nekko Voice isn’t installed on $name (Settings → Nekko Voice there)."
        !enabled -> "Nekko Voice is turned off on $name (Settings → Nekko Voice there)."
        else -> ""
    }

    companion object {
        val UNKNOWN = ComputerVoice(online = false, installed = false, enabled = false)
    }
}

/**
 * The dictation rules, pure so they are tested on the JVM. The microphone only
 * ever fills the message box: the user reads the text and presses Send.
 */
object Dictation {
    val ENABLED = PhonePrefs.boolean("dictation.enabled", default = true)
    val ENGINE = PhonePrefs.enum("dictation.engine", EngineChoice.COMPUTER_FIRST)

    /** BCP-47 tag for the phone's recognizer; empty means the phone's own language. */
    val LANGUAGE = PhonePrefs.string("dictation.language", default = "")

    /** Which engine to use now, or null when dictation can't run (and [why] says so). */
    fun engine(choice: EngineChoice, computer: ComputerVoice, phoneAvailable: Boolean): Engine? = when (choice) {
        EngineChoice.COMPUTER_FIRST -> when {
            computer.ready -> Engine.COMPUTER
            phoneAvailable -> Engine.PHONE
            else -> null
        }
        EngineChoice.COMPUTER_ONLY -> if (computer.ready) Engine.COMPUTER else null
        EngineChoice.PHONE -> if (phoneAvailable) Engine.PHONE else null
    }

    fun why(choice: EngineChoice, computer: ComputerVoice, phoneAvailable: Boolean, name: String): String = when (choice) {
        EngineChoice.COMPUTER_ONLY -> computer.whyNot(name)
        EngineChoice.PHONE -> if (phoneAvailable) "" else "This phone has no speech recognizer."
        EngineChoice.COMPUTER_FIRST ->
            if (computer.ready || phoneAvailable) "" else "${computer.whyNot(name)} This phone has no speech recognizer either."
    }

    /**
     * Put dictated [spoken] text into the message box at the cursor: never
     * replaces what the user typed, adds a space between words, trims Whisper's
     * leading space and its "[BLANK_AUDIO]"-style markers.
     */
    fun insert(current: String, cursor: Int, spoken: String): Pair<String, Int> {
        val clean = clean(spoken)
        if (clean.isEmpty()) return current to cursor.coerceIn(0, current.length)
        val at = cursor.coerceIn(0, current.length)
        val before = current.substring(0, at)
        val after = current.substring(at)
        val lead = if (before.isNotEmpty() && !before.last().isWhitespace()) " " else ""
        val tail = if (after.isNotEmpty() && !after.first().isWhitespace()) " " else ""
        val next = before + lead + clean + tail + after
        return next to (before.length + lead.length + clean.length)
    }

    /**
     * Whisper writes non-speech as bracketed or parenthesised tags
     * ("[BLANK_AUDIO]", "[ Silence ]", "[Music]", "(wind blowing)"); none of
     * them are words the user said.
     */
    fun clean(spoken: String): String =
        spoken.replace(Regex("""\[[^\]\n]{1,40}]|\([^)\n]{1,40}\)"""), " ").replace(Regex("""\s+"""), " ").trim()

    /** "0:07 / 0:30" for the recording bar. */
    fun clock(samples: Int): String {
        val s = samples / Wav.SAMPLE_RATE
        return "%d:%02d / %d:%02d".format(s / 60, s % 60, Wav.MAX_SECONDS / 60, Wav.MAX_SECONDS % 60)
    }
}
