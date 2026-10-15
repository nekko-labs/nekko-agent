package com.nekko.android

import com.nekko.android.data.ModelChoice
import com.nekko.android.data.ModelGroup
import com.nekko.android.data.ModelPick
import com.nekko.android.data.NewChatDefaults
import com.nekko.android.data.PhonePrefs
import com.nekko.protocol.AUTO_MODEL_ID
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RemoteDefaults
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NewChatDefaultsTest {
    private val store = MapPrefStore()
    private val d = NewChatDefaults(PhonePrefs(store))
    private val qwen = ModelPick("lms", "qwen3")
    private val opus = ModelPick("anthropic", "claude-opus")

    @Test
    fun `nothing set by default`() {
        assertNull(d.computerId())
        assertNull(d.model("pc-1"))
        assertTrue(store.map.isEmpty())
    }

    @Test
    fun `a model per computer, saved and read back by a fresh instance`() {
        d.setModel("pc-1", qwen)
        d.setModel("pc-2", opus)
        val again = NewChatDefaults(PhonePrefs(store))
        assertEquals(qwen, again.model("pc-1"))
        assertEquals(opus, again.model("pc-2"))
        d.setModel("pc-1", null)
        assertNull(d.model("pc-1"))
        assertEquals(opus, d.model("pc-2"))
    }

    @Test
    fun `clearing the last model removes the stored value`() {
        d.setModel("pc-1", qwen)
        d.setModel("pc-1", null)
        assertFalse(store.map.containsKey(NewChatDefaults.MODELS.name))
    }

    @Test
    fun `forgetting a computer drops its default and its model`() {
        d.setComputer("pc-1")
        d.setModel("pc-1", qwen)
        d.setModel("pc-2", opus)
        d.forget("pc-1")
        assertNull(d.computerId())
        assertNull(d.model("pc-1"))
        assertEquals(opus, d.model("pc-2"))
    }

    @Test
    fun `forgetting another computer keeps the default`() {
        d.setComputer("pc-1")
        d.forget("pc-2")
        assertEquals("pc-1", d.computerId())
    }

    @Test
    fun `corrupt or auto entries are ignored`() {
        store.map[NewChatDefaults.MODELS.name] = "pc-1\tlms\tqwen3\nbroken line\npc-2\tx\t$AUTO_MODEL_ID\n\tp\tm"
        assertEquals(mapOf("pc-1" to qwen), NewChatDefaults.decode(store.map.getValue(NewChatDefaults.MODELS.name)))
    }

    @Test
    fun `ids with a tab are never written`() {
        assertEquals("", NewChatDefaults.encode(mapOf("pc\t1" to qwen)))
    }

    @Test
    fun `start computer prefers the phone default, then the last used, then the first`() {
        val paired = listOf("a", "b", "c")
        assertEquals("b", NewChatDefaults.startComputer("b", "c", paired))
        assertEquals("c", NewChatDefaults.startComputer("gone", "c", paired))
        assertEquals("c", NewChatDefaults.startComputer(null, "c", paired))
        assertEquals("a", NewChatDefaults.startComputer(null, "gone", paired))
        assertNull(NewChatDefaults.startComputer("a", "a", emptyList()))
    }

    // ModelChoice with the phone's pick.

    private val lms = PublicProvider("lms", "lmstudio", "LM Studio", true)
    private val ant = PublicProvider("anthropic", "anthropic", "Anthropic", true)
    private fun m(id: String, provider: String) = ModelInfo(id = id, providerId = provider, name = id, loaded = false)
    private val groups = listOf(ModelGroup(lms, listOf(m("qwen3", "lms"), m("gemma", "lms"))), ModelGroup(ant, listOf(m("claude-opus", "anthropic"))))
    private val computerDefault = RemoteDefaults(defaultProviderId = "anthropic", defaultModelId = "claude-opus")

    @Test
    fun `the phone's pick wins over the computer's default`() {
        assertEquals(qwen, ModelChoice.initial(computerDefault, emptyList(), groups, phonePick = qwen))
    }

    @Test
    fun `a missing phone pick falls back to the computer's default and says so`() {
        val gone = ModelPick("lms", "llama-removed")
        assertEquals(opus, ModelChoice.initial(computerDefault, emptyList(), groups, phonePick = gone))
        assertTrue(ModelChoice.phonePickMissing(gone, groups))
        assertFalse(ModelChoice.phonePickMissing(qwen, groups))
        assertFalse(ModelChoice.phonePickMissing(null, groups))
    }

    @Test
    fun `no false alarm while a provider is still answering`() {
        val loading = listOf(ModelGroup(lms, null), ModelGroup(ant, listOf(m("claude-opus", "anthropic"))))
        assertFalse(ModelChoice.phonePickMissing(qwen, loading))
    }

    @Test
    fun `without a phone pick nothing changes`() {
        assertEquals(opus, ModelChoice.initial(computerDefault, emptyList(), groups))
    }
}
