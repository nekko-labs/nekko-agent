package com.nekko.android

import com.nekko.android.data.ModelChoice
import com.nekko.android.data.ModelGroup
import com.nekko.android.data.ModelScope
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.PublicProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The model picker's All / Cloud / Local tabs, after the desktop's Model source group and the iPhone's tabs. */
class ModelScopeTest {
    private val cloud = PublicProvider("anthropic", "anthropic", "Claude API", true)
    private val local = PublicProvider("ollama", "ollama", "Ollama", true)
    private val server = PublicProvider("nekko-engine", "llamacpp", "Model Server", true)
    private val groups = listOf(
        ModelGroup(cloud, listOf(ModelInfo("opus", "anthropic", "Claude Opus 5.5", false))),
        ModelGroup(local, listOf(ModelInfo("qwen3:8b", "ollama", "Qwen3 8B", true))),
        ModelGroup(server, listOf(ModelInfo("gemma", "nekko-engine", "Gemma", false))),
    )

    @Test
    fun `tabs are All, Cloud, Local in the desktop and iPhone order, opening on All`() {
        assertEquals(listOf(ModelScope.ALL, ModelScope.CLOUD, ModelScope.LOCAL), ModelScope.entries)
        assertEquals(ModelScope.ALL, ModelScope.entries.first())
    }

    @Test
    fun `All lists every provider in order`() {
        assertEquals(listOf("anthropic", "ollama", "nekko-engine"), ModelScope.ALL.groups(groups).map { it.provider.id })
    }

    @Test
    fun `Cloud lists only cloud APIs and Local only the model servers`() {
        assertEquals(listOf("anthropic"), ModelScope.CLOUD.groups(groups).map { it.provider.id })
        assertEquals(listOf("ollama", "nekko-engine"), ModelScope.LOCAL.groups(groups).map { it.provider.id })
        for (kind in listOf("lmstudio", "vllm")) assertTrue(kind, ModelScope.LOCAL.includes(PublicProvider(kind, kind, kind, true)))
        for (kind in listOf("openai", "openai-compat", "openrouter")) assertTrue(kind, ModelScope.CLOUD.includes(PublicProvider(kind, kind, kind, true)))
    }

    @Test
    fun `an empty tab lists nothing`() {
        assertTrue(ModelScope.LOCAL.groups(groups.take(1)).isEmpty())
        assertTrue(ModelScope.CLOUD.groups(groups.drop(1)).isEmpty())
    }

    @Test
    fun `starred models follow the tab`() {
        val stars = listOf("anthropic::opus", "ollama::qwen3:8b", "gone::x")
        assertEquals(listOf("opus", "qwen3:8b"), ModelChoice.starred(ModelScope.ALL.groups(groups), stars).map { it.second.id })
        assertEquals(listOf("opus"), ModelChoice.starred(ModelScope.CLOUD.groups(groups), stars).map { it.second.id })
        assertEquals(listOf("qwen3:8b"), ModelChoice.starred(ModelScope.LOCAL.groups(groups), stars).map { it.second.id })
    }

    @Test
    fun `search works within the tab`() {
        assertTrue(ModelChoice.filter(ModelScope.CLOUD.groups(groups), "qwen").isEmpty())
        assertEquals(listOf("ollama"), ModelChoice.filter(ModelScope.LOCAL.groups(groups), "qwen").map { it.provider.id })
    }
}
