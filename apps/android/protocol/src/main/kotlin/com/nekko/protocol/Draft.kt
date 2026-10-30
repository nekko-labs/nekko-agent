package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What a composer holds before it is sent: a chat's, or New chat's (which also
 * keeps its model, folder, tool policy and effort). Photos are the
 * already-scaled JPEG data URLs the computer receives. The same shape as the
 * iPhone app's `Draft` (NekkoKit/Drafts.swift).
 */
data class Draft(
    val text: String = "",
    val skill: SkillSummary? = null,
    val images: List<String> = emptyList(),
    /** New chat only: the model, folder, tool policy and effort picked for it. */
    val providerId: String? = null,
    val modelId: String? = null,
    val workspaceId: String? = null,
    val mode: String? = null,
    val effort: String? = null,
    /** Why the computer turned this prompt down, when it came back from the outbox. */
    val refusal: String? = null,
) {
    /** Nothing worth keeping: no words, skill or photos, and no New chat choices. */
    val isEmpty: Boolean
        get() = text.isBlank() && skill == null && images.isEmpty() &&
            providerId == null && modelId == null && workspaceId == null && mode == null && effort == null && refusal == null

    /** Something to send: words, a skill or a photo. */
    val hasContent: Boolean get() = text.isNotBlank() || skill != null || images.isNotEmpty()

    /** [back] (a prompt the computer refused, or one taken back to edit) in front of what is typed now, so neither is lost. */
    fun merging(back: Draft): Draft = copy(
        text = if (text.isBlank()) back.text else back.text + "\n\n" + text,
        skill = skill ?: back.skill,
        images = (back.images + images).take(MAX_IMAGES),
        providerId = providerId ?: back.providerId,
        modelId = modelId ?: back.modelId,
        workspaceId = workspaceId ?: back.workspaceId,
        mode = mode ?: back.mode,
        effort = effort ?: back.effort,
        refusal = back.refusal ?: refusal,
    )

    fun json(): JsonObject = buildJsonObject {
        put("text", text)
        skill?.let { put("skill", it.json()) }
        if (images.isNotEmpty()) put("images", JsonArray(images.map(::JsonPrimitive)))
        providerId?.let { put("providerId", it) }
        modelId?.let { put("modelId", it) }
        workspaceId?.let { put("workspaceId", it) }
        mode?.let { put("mode", it) }
        effort?.let { put("effort", it) }
        refusal?.let { put("refusal", it) }
    }

    companion object {
        /** As many photos as one prompt takes (the composer's limit). */
        const val MAX_IMAGES = 4

        fun from(e: JsonElement?): Draft? {
            val o = e.obj() ?: return null
            return Draft(
                text = o.str("text") ?: "",
                skill = SkillSummary.from(o["skill"]),
                images = o["images"].arr()?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList(),
                providerId = o.str("providerId"),
                modelId = o.str("modelId"),
                workspaceId = o.str("workspaceId"),
                mode = o.str("mode"),
                effort = o.str("effort"),
                refusal = o.str("refusal"),
            )
        }
    }
}

/** A skill as the phone keeps it in a draft: its name, description, category and source, never its instructions. */
fun SkillSummary.json(): JsonObject = buildJsonObject {
    put("name", name)
    put("description", description)
    put("category", category)
    put("source", source)
}
