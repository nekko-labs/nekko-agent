package com.nekko.protocol

/**
 * The computer refused a channel from this phone. Its reply is the error string
 * `Not allowed from a paired phone (<code>): <detail>`; this pulls out the code
 * and detail so the app can say what to do in plain words. Mirrors `PhoneRefusal`
 * in apps/ios/Protocol/Sources/NekkoProtocol/ChangeProof.swift.
 *
 * Codes: `read-off` and `change-off` (Remote access → What phones can do is off
 * for that kind of channel), `proof-*` (raising a chat's mode needs a signed
 * Change proof, which this app can't make yet; the detail is the channel),
 * `device-unknown`, `channel-denied` (the computer doesn't know the channel),
 * `step-up-required|invalid|stale|replayed` (the computer wants a second
 * factor too, SK-7; [asksForStepUp]) and `quit-disabled` (SK-3).
 */
data class PhoneRefusal(val code: String, val detail: String) {
    /** A missing or rejected Change proof. */
    val isProof: Boolean get() = code.startsWith("proof-")

    /** Refused for want of a proof when raising a chat's mode (new chats or this one). */
    val isModeChange: Boolean get() = isProof && detail in MODE_CHANNELS

    /** A step-up refusal (SK-7) or `quit-disabled`; null for every other code. */
    val stepUp: StepUpCode? get() = StepUpCode.of(code)

    /** A guarded call that a step-up sheet can answer: ask for a key or a code, then send it again. */
    val asksForStepUp: Boolean get() = stepUp?.asksAgain == true

    /** What to tell the owner, or null to show the computer's message as it is. */
    fun message(computer: String): String? = stepUp?.message ?: when {
        code == "read-off" ->
            "Reading from this phone is turned off on $computer. Turn it on in Remote access → What phones can do."
        code == "change-off" ->
            "Changes from this phone are turned off on $computer. Turn them on in Remote access → What phones can do."
        isModeChange ->
            "Switching to Guardrails or YOLO needs a confirmation this phone can’t give yet. Change the mode on $computer."
        isProof ->
            "$computer needs a confirmation this phone can’t give yet. Do this on $computer."
        code == "device-unknown" -> "$computer doesn’t know this phone any more. Pair it again."
        code == "channel-denied" -> "$computer doesn’t allow this from a phone. Update Nekko Agent on $computer if it’s new."
        code == "value-invalid" && detail == "secret file" -> "This file may hold secrets, so it never leaves $computer."
        else -> null
    }

    companion object {
        private const val PREFIX = "Not allowed from a paired phone ("

        /** The channels whose mode change needs a proof. */
        private val MODE_CHANNELS = setOf(Channels.SESSION_SET_OPTIONS, Channels.SETTINGS_UPDATE)

        /** The refusal in a call's error message, or null for any other error. */
        fun parse(message: String?): PhoneRefusal? {
            if (message == null || !message.startsWith(PREFIX)) return null
            val rest = message.substring(PREFIX.length)
            val close = rest.indexOf(')')
            if (close < 0) return null
            return PhoneRefusal(rest.substring(0, close), rest.substring(close + 1).trim(':', ' '))
        }
    }
}
