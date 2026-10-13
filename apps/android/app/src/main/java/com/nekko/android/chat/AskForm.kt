package com.nekko.android.chat

import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskQuestion
import com.nekko.protocol.AskRequest

/**
 * The question card's state, kept pure so it can be tested: option picks per
 * question (single or multi select) plus a free-text "Something else" note.
 */
data class AskForm(
    val picked: Map<String, List<String>> = emptyMap(),
    val notes: Map<String, String> = emptyMap(),
) {
    fun toggle(q: AskQuestion, label: String): AskForm {
        val cur = picked[q.id] ?: emptyList()
        val next = if (q.multiSelect) {
            if (label in cur) cur - label else cur + label
        } else {
            if (cur.firstOrNull() == label) emptyList() else listOf(label)
        }
        return copy(picked = picked + (q.id to next))
    }

    fun note(q: AskQuestion, text: String): AskForm = copy(notes = notes + (q.id to text))

    fun isPicked(q: AskQuestion, label: String) = picked[q.id]?.contains(label) == true

    /** Every question has a pick or a note (shared/ask.ts `isAskComplete`). */
    fun complete(request: AskRequest): Boolean = request.questions.all { q ->
        (picked[q.id]?.isNotEmpty() == true) || (notes[q.id]?.isNotBlank() == true)
    }

    /** Answers for `chat:answer`; questions left blank are omitted (they read back as unanswered). */
    fun answers(request: AskRequest): List<AskAnswer> = request.questions.map { q ->
        AskAnswer(q.id, picked[q.id] ?: emptyList(), notes[q.id]?.trim()?.ifEmpty { null })
    }.filter { it.labels.isNotEmpty() || it.note != null }
}
