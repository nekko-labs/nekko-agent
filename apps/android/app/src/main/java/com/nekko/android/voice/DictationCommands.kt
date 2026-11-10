package com.nekko.android.voice

/**
 * The composer's microphone through the chat's [VoiceRunner] (the iPhone's Dictation into
 * `VoiceRunner`): each pause's words are typed, or run as "Nekko, …" commands ("Nekko, send",
 * "Nekko, erase that", "Nekko, open the docs chat"). [ChatVoiceControls] installs [claim] while it
 * is on screen; without it (voice controls not shown, not authorized) the words are typed as before.
 * Main thread only.
 */
class DictationCommands {
    /** Takes the voice lease for this chat and returns where the words go, or null to type them plainly. */
    internal var claim: (() -> ((String) -> Unit)?)? = null

    /** Dictation is starting: the words' sink, or null when commands can't run now. */
    fun start(): ((String) -> Unit)? = claim?.invoke()
}
