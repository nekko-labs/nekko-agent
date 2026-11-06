package com.nekko.protocol

// Which computers a chat's model can run on (T201a, New chat's Run on). Mirrors
// `LOCAL_PROVIDER_KINDS` (packages/shared/src/models.ts). Effort levels are
// `Effort` in HardwareMonitor.kt.

/** On-device model servers: a chat on one runs on that computer's hardware, so New chat offers *Run on*. */
object LocalProviders {
    val KINDS = setOf("llamacpp", "ollama", "lmstudio", "vllm")

    fun isLocal(kind: String?): Boolean = kind in KINDS
}
