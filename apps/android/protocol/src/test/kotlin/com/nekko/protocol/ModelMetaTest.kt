package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The iPhone's ModelMetaTests and PhoneModelMetaTests (#2925), case for case. */
class ModelMetaTest {
    @Test fun `local models show parameters and size`() {
        assertEquals("8B · 4.9 GB", ModelMeta.line(local = true, parameters = "8B", sizeBytes = 4_920_000_000))
        assertEquals("3.1 GB", ModelMeta.line(local = true, sizeBytes = 3_100_000_000))
        assertEquals("16 GB", ModelMeta.line(local = true, sizeBytes = 16_000_000_000))
        assertEquals("850 MB", ModelMeta.line(local = true, sizeBytes = 850_000_000))
        assertNull(ModelMeta.line(local = true, parameters = " ", sizeBytes = 0))
        // A local model's context is not what its row is about.
        assertNull(ModelMeta.line(local = true, contextLength = 32_768))
    }

    @Test fun `cloud models show context only when listed`() {
        assertEquals("400K context", ModelMeta.line(local = false, contextLength = 400_000))
        assertEquals("1M context", ModelMeta.line(local = false, contextLength = 1_000_000))
        assertEquals("1M context", ModelMeta.line(local = false, contextLength = 1_048_576))
        assertEquals("128K context", ModelMeta.line(local = false, contextLength = 128_000))
        assertEquals("1.5M context", ModelMeta.line(local = false, contextLength = 1_500_000))
        assertNull(ModelMeta.line(local = false, sizeBytes = 9_000_000_000))
        assertNull(ModelMeta.line(local = false))
    }

    @Test fun `date suffixes`() {
        assertEquals("o3", ModelSnapshots.base("o3-2025-04-16"))
        assertEquals("gpt-5.5-pro", ModelSnapshots.base("gpt-5.5-pro-2026-04-23"))
        assertEquals("claude-sonnet-4", ModelSnapshots.base("claude-sonnet-4-20250514"))
        assertNull(ModelSnapshots.base("gpt-6.1-sol"))
        assertNull(ModelSnapshots.base("qwen3:8b"))
        assertNull(ModelSnapshots.base("claude-opus-4-8"))
        assertNull(ModelSnapshots.base("2025-04-16"))
    }

    @Test fun `snapshots fold under their model`() {
        val folds = ModelSnapshots.fold(listOf("o3-2025-04-16", "o3", "gpt-live-1", "gpt-5.5-pro-2026-04-23", "gpt-5.5-pro"))
        assertEquals(listOf(
            ModelSnapshots.Fold("o3", listOf("o3-2025-04-16")),
            ModelSnapshots.Fold("gpt-live-1", emptyList()),
            ModelSnapshots.Fold("gpt-5.5-pro", listOf("gpt-5.5-pro-2026-04-23")),
        ), folds)
    }

    @Test fun `without the plain id the newest snapshot leads`() {
        assertEquals(
            listOf(ModelSnapshots.Fold("gpt-4.1-2025-04-14", listOf("gpt-4.1-2025-01-01", "gpt-4.1-2024-11-20"))),
            ModelSnapshots.fold(listOf("gpt-4.1-2025-01-01", "gpt-4.1-2025-04-14", "gpt-4.1-2024-11-20")),
        )
    }

    @Test fun `model info keeps size context and details`() {
        val list = ModelInfo.list(Json.parseToJsonElement("""[
            {"id":"qwen3:8b","providerId":"ollama","name":"qwen3:8b","sizeBytes":5200000000,"details":{"family":"qwen3","parameterSize":"8B","n":3}},
            {"id":"openai/gpt-6.1-sol","providerId":"openrouter","contextLength":400000,"sizeBytes":0}
        ]"""))
        assertEquals(5_200_000_000L, list[0].sizeBytes)
        assertEquals("8B", list[0].parameters)
        assertEquals(mapOf("family" to "qwen3", "parameterSize" to "8B"), list[0].details)
        assertNull(list[0].contextLength)
        assertEquals(400_000L, list[1].contextLength)
        assertNull("a zero size is unknown", list[1].sizeBytes)
        assertEquals("8B · 5.2 GB", ModelMeta.line(local = true, parameters = list[0].parameters, sizeBytes = list[0].sizeBytes))
    }

    @Test fun `phone context length only where the list gives one`() {
        val openRouter = """{"data":[{"id":"openai/gpt-6.1-sol","name":"GPT-6.1 Sol","context_length":400000},{"id":"x/tiny","context_length":0}]}"""
        assertEquals(listOf(400_000L, null), PhoneProviders.models(openRouter, "openrouter").map { it.contextLength })
        assertNull(PhoneProviders.models("""{"data":[{"id":"gpt-6.1-sol","created":1760000000}]}""", "openai").first().contextLength)
        val anthropic = """{"data":[{"id":"claude-sonnet-5-5","display_name":"Claude Sonnet 5.5","max_input_tokens":1000000}]}"""
        assertEquals(1_000_000L, PhoneProviders.models(anthropic, "anthropic").first().contextLength)
    }

    @Test fun `saved phone models without context still decode`() {
        assertNull(Json { ignoreUnknownKeys = true }.decodeFromString(PhoneModel.serializer(), """{"id":"gpt-6.1-sol","name":"gpt-6.1-sol"}""").contextLength)
    }
}
