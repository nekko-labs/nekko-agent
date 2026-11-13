package com.nekko.protocol

/**
 * How models running on the phone talk (Customize → Phone-hosted chats, the iPhone's `PhoneTone`,
 * #2426): a communication preference added to their system prompt, not a permission or another
 * identity. Chats on a computer keep that computer's tone and standing instructions. The
 * instructions stay English: they are read by the model, not shown.
 */
enum class PhoneTone(val wire: String, val instructions: String) {
    STANDARD("Default", ""),
    FRIENDLY("Friendly", "Use a warm, approachable tone. Stay honest, clear and concise."),
    PROFESSIONAL("Professional", "Use a calm, professional tone with precise, direct language."),
    CONCISE("Concise", "Keep replies brief and focused on the answer, essential caveats and next steps."),
    EXPLANATORY("Explanatory", "Explain the reasoning at a useful level, with clear examples when helpful."),
    ;

    /** The system prompt for the next phone-hosted reply. */
    val systemPrompt: String
        get() = if (instructions.isEmpty()) PhoneProviders.SYSTEM else PhoneProviders.SYSTEM + "\n\nCommunication preference: " + instructions

    companion object {
        /** A saved choice, or Default when it is missing or no longer known. */
        fun parse(raw: String?): PhoneTone = entries.firstOrNull { it.wire == raw } ?: STANDARD
    }
}
