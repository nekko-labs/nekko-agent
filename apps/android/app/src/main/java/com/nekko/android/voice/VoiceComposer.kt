package com.nekko.android.voice

/** Live access to the actual composer, including saved-prompt/skill/photo state, not a parallel voice draft. */
class VoiceComposer(
    val read: () -> VoiceTurn.Draft,
    /** Compare-and-set preserves edits made while a send/authentication was pending. */
    val replace: (expected: String, replacement: String) -> Boolean,
)
