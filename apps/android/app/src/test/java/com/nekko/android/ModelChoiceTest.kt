package com.nekko.android

import com.nekko.android.data.ModelChoice
import com.nekko.android.data.ModelGroup
import com.nekko.android.data.ModelPick
import com.nekko.protocol.AUTO_MODEL_ID
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.SessionSummary
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelChoiceTest {
    private val engine = PublicProvider("nekko-engine", "llamacpp", "Nekko Agent engine", true)
    private val claude = PublicProvider("anthropic", "anthropic", "Anthropic (Claude)", true)
    private val groups = listOf(
        ModelGroup(engine, listOf(ModelInfo("qwen", "nekko-engine", "Qwen3.8 Flash", true))),
        ModelGroup(claude, listOf(ModelInfo("opus", "anthropic", "Claude Opus 5.5", false), ModelInfo("sonnet", "anthropic", "Claude Sonnet 5", false))),
    )

    private fun summary(id: String, at: Long, provider: String?, model: String?) =
        SessionSummary(id, id, at, model, null, null, false, null, null, null, provider)

    @Test
    fun `initial prefers the computer default, then the latest chat's model, then a starred one`() {
        val recent = listOf(summary("old", 1, "nekko-engine", "qwen"), summary("new", 9, "anthropic", "sonnet"))
        assertEquals(ModelPick("anthropic", "opus"), ModelChoice.initial(RemoteDefaults("anthropic", "opus"), recent, groups))
        // No default set on the computer (a fresh install): the latest chat's model.
        assertEquals(ModelPick("anthropic", "sonnet"), ModelChoice.initial(RemoteDefaults(), recent, groups))
        // Auto is never a concrete pick.
        assertEquals(ModelPick("anthropic", "sonnet"), ModelChoice.initial(RemoteDefaults("anthropic", AUTO_MODEL_ID), recent, groups))
        assertEquals(
            ModelPick("nekko-engine", "qwen"),
            ModelChoice.initial(RemoteDefaults(favoriteModels = listOf("nekko-engine::qwen")), emptyList(), groups),
        )
        assertNull(ModelChoice.initial(RemoteDefaults(), emptyList(), groups))
    }

    @Test
    fun `a remembered pick that is no longer listed is skipped`() {
        val recent = listOf(summary("gone", 9, "anthropic", "retired"), summary("ok", 1, "nekko-engine", "qwen"))
        assertEquals(ModelPick("nekko-engine", "qwen"), ModelChoice.initial(RemoteDefaults("x", "y"), recent, groups))
        assertFalse(ModelChoice.exists(ModelPick("anthropic", "retired"), groups))
        assertFalse(ModelChoice.exists(ModelPick("anthropic", "opus"), listOf(ModelGroup(claude, null))))
    }

    @Test
    fun `starred keeps the computer's order and drops unknown keys`() {
        val s = ModelChoice.starred(groups, listOf("anthropic::sonnet", "bad", "nekko-engine::qwen", "anthropic::retired"))
        assertEquals(listOf("sonnet", "qwen"), s.map { it.second.id })
    }

    @Test
    fun `filter matches model name, id or provider label`() {
        assertEquals(listOf("sonnet"), ModelChoice.filter(groups, "SONNET").single().models?.map { it.id })
        assertEquals(2, ModelChoice.filter(groups, "claude").single().models?.size)
        assertEquals(listOf("nekko-engine"), ModelChoice.filter(groups, "engine").map { it.provider.id })
        assertTrue(ModelChoice.filter(groups, "nothing").isEmpty())
        assertEquals(groups, ModelChoice.filter(groups, "  "))
    }

    @Test
    fun `loading until every provider has answered or failed`() {
        assertTrue(ModelChoice.loading(listOf(ModelGroup(engine, null))))
        assertFalse(ModelChoice.loading(listOf(ModelGroup(engine, null, "off"), groups[1])))
    }

    @Test
    fun `wire decoders read the chat's provider and the starred models`() {
        val s = SessionSummary.from(Json.parseToJsonElement("""{"id":"a","providerId":"anthropic","modelId":"opus","updatedAt":1}"""))!!
        assertEquals("anthropic", s.providerId)
        val d = RemoteDefaults.from(Json.parseToJsonElement("""{"favoriteModels":["anthropic::opus",3],"apiKey":"x"}"""))
        assertEquals(listOf("anthropic::opus"), d.favoriteModels)
    }
}
