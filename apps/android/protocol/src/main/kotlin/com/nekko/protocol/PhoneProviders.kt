package com.nekko.protocol

import java.net.URI
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class PhoneProvider(val id: String, val kind: String, val label: String, val baseUrl: String, val workspaceId: String? = null, val enabled: Boolean = true)
@Serializable data class PhoneModel(val id: String, val name: String)
@Serializable data class PhoneMessage(val id: String, val role: String, val text: String, val at: Long, val error: String? = null)
@Serializable data class PhoneChat(val id: String, val title: String, val providerId: String, val modelId: String, val createdAt: Long, val updatedAt: Long, val messages: List<PhoneMessage> = emptyList())
data class PhoneRequest(val url: String, val headers: Map<String, String>, val body: JsonObject? = null, val method: String = "POST")

/** Direct phone APIs only. No subscription harnesses, local servers, tools or relay. */
object PhoneProviders {
    data class Kind(val id: String, val label: String, val defaultUrl: String, val catalog: List<PhoneModel> = emptyList(), val keyOptional: Boolean = false, val hint: String = "Use your own provider API key.")
    private val claude = listOf("opus-5-5", "sonnet-5-5", "fable-5-1", "haiku-5-5", "opus-4-8", "sonnet-4-6").map { PhoneModel("claude-$it", "Claude $it") }
    val kinds = listOf(
        Kind("anthropic", "Claude API", "https://api.anthropic.com"),
        Kind("openai", "OpenAI", "https://api.openai.com/v1"),
        Kind("openrouter", "OpenRouter", "https://openrouter.ai/api/v1"),
        Kind("bedrock", "Claude in Amazon Bedrock", "https://bedrock-mantle.us-east-1.api.aws/anthropic", claude.map { it.copy(id = "anthropic.${it.id}") }, hint = "Bedrock API key. Set your region in the address."),
        Kind("foundry", "Claude in Microsoft Foundry", "https://YOUR_RESOURCE.services.ai.azure.com/anthropic", claude, hint = "Resource key. Set your resource in the address."),
        Kind("vertex", "Claude on Vertex AI", "https://aiplatform.googleapis.com/v1/projects/YOUR_PROJECT/locations/global", claude, hint = "Google access token. Replace it when it expires (about an hour)."),
        Kind("openai-compat", "OpenAI-compatible", "https://", keyOptional = true, hint = "An HTTPS OpenAI-compatible endpoint. Key optional.")
    )
    fun kind(id: String) = kinds.firstOrNull { it.id == id }
    fun make(id: String, kind: String, label: String, baseUrl: String?, key: String?, workspaceId: String? = null): PhoneProvider {
        val k = requireNotNull(kind(kind)) { "Unsupported phone provider." }
        require(label.trim().isNotEmpty()) { "Give the provider a name." }
        val url = baseUrl?.trim()?.ifEmpty { null }?.trimEnd('/') ?: k.defaultUrl
        val uri = runCatching { URI(url) }.getOrNull()
        require(uri != null && uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && !url.contains("YOUR_")) { "Use a full HTTPS address without credentials, query or fragment." }
        require(k.keyOptional || !key.isNullOrBlank()) { "Paste the key." }
        require(workspaceId?.any { it == '\r' || it == '\n' } != true) { "The workspace ID must be one line." }
        require(key?.any { it == '\r' || it == '\n' } != true) { "The key must be one line." }
        return PhoneProvider(id, kind, label.trim(), url, workspaceId?.trim()?.ifEmpty { null }?.takeIf { kind == "anthropic" })
    }
    private fun anthropic(p: PhoneProvider) = p.kind in setOf("anthropic", "bedrock", "foundry", "vertex")
    private fun headers(p: PhoneProvider, key: String?): Map<String, String> = buildMap {
        put("Content-Type", "application/json")
        if (p.kind in setOf("anthropic", "foundry")) put("x-api-key", key.orEmpty())
        else if (!key.isNullOrBlank()) put("Authorization", "Bearer $key")
        if (anthropic(p) && p.kind != "vertex") put("anthropic-version", "2023-06-01")
        if (p.kind == "anthropic") p.workspaceId?.let { put("anthropic-workspace-id", it) }
        if (p.kind == "openrouter") put("X-Title", "Nekko Agent")
    }
    fun chatRequest(p: PhoneProvider, key: String?, model: String, messages: List<PhoneMessage>, system: String? = "You are Nekko Agent on the user's Android phone. You have no tools and cannot see computers, files or the web. Answer in Markdown.", maxTokens: Int = 8192): PhoneRequest {
        require(model.isNotBlank() && (p.kind != "vertex" || model.matches(Regex("[a-zA-Z0-9@._:-]+")))) { "Invalid model id." }
        val a = anthropic(p)
        val body = buildJsonObject {
            put("stream", true)
            if (p.kind != "vertex") put("model", model)
            if (a) { put("max_tokens", maxTokens); system?.let { put("system", it) } }
            if (p.kind == "vertex") put("anthropic_version", "vertex-2023-10-16")
            if (p.kind in setOf("openai", "openrouter")) putJsonObject("stream_options") { put("include_usage", true) }
            putJsonArray("messages") {
                if (!a && system != null) add(buildJsonObject { put("role", "system"); put("content", system) })
                messages.filter { it.text.isNotBlank() && it.role in setOf("user", "assistant") }.forEach { m -> add(buildJsonObject { put("role", m.role); put("content", m.text) }) }
            }
        }
        val path = when { p.kind == "vertex" -> "/publishers/anthropic/models/$model:streamRawPredict"; a -> "/v1/messages"; else -> "/chat/completions" }
        return PhoneRequest(p.baseUrl + path, headers(p, key), body)
    }
    fun modelsRequest(p: PhoneProvider, key: String?): PhoneRequest? = if (kind(p.kind)?.catalog?.isNotEmpty() == true) null else PhoneRequest(p.baseUrl + if (p.kind == "anthropic") "/v1/models?limit=1000" else "/models", headers(p, key), method = "GET")
    fun models(body: String, kind: String): List<PhoneModel> {
        val data = Json.parseToJsonElement(body).jsonObject["data"]?.jsonArray ?: return emptyList()
        val skip = listOf("embedding", "whisper", "tts", "dall-e", "moderation", "image", "audio", "realtime", "transcribe", "search", "davinci", "babbage", "sora")
        return data.mapNotNull { e ->
            val o = e.jsonObject; val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            if (id.isBlank() || kind == "openai" && skip.any { id.contains(it) }) null else PhoneModel(id, o["display_name"]?.jsonPrimitive?.contentOrNull ?: o["name"]?.jsonPrimitive?.contentOrNull ?: id)
        }.distinctBy { it.id }
    }
    // Never echo response bodies: an untrusted endpoint may echo credentials in an error.
    fun failure(status: Int, body: String = "") = when (status) {
        401, 403 -> "The provider turned the key down ($status). Replace the key and test again."
        404 -> "The provider does not know that address or model (404)."
        429 -> "The provider is rate limiting this key (429). Try again later."
        else -> "The provider answered $status."
    }
}

sealed interface PhoneStreamEvent {
    data class Text(val text: String) : PhoneStreamEvent
    data class Failure(val message: String) : PhoneStreamEvent
    data object Done : PhoneStreamEvent
}

/** SSE frames may contain several data lines. Completion must be explicit, not just EOF. */
class PhoneStreamParser {
    private val data = mutableListOf<String>()
    private var done = false
    fun line(line: String): List<PhoneStreamEvent> {
        if (done) return emptyList()
        if (line.startsWith("data:")) { data += line.removePrefix("data:").trimStart(); return emptyList() }
        if (line.isNotEmpty() || data.isEmpty()) return emptyList()
        val value = data.joinToString("\n"); data.clear()
        if (value == "[DONE]") { done = true; return listOf(PhoneStreamEvent.Done) }
        val o = runCatching { Json.parseToJsonElement(value).jsonObject }.getOrNull()
            ?: return listOf(PhoneStreamEvent.Failure("The provider sent an unreadable stream."))
        if (o["error"] != null || o["type"]?.jsonPrimitive?.contentOrNull == "error") return listOf(PhoneStreamEvent.Failure("The provider stopped with an error. Test the provider and retry."))
        val type = o["type"]?.jsonPrimitive?.contentOrNull
        if (type == "message_stop") { done = true; return listOf(PhoneStreamEvent.Done) }
        val out = mutableListOf<PhoneStreamEvent>()
        if (type == "content_block_delta") o["delta"]?.jsonObject?.get("text")?.jsonPrimitive?.contentOrNull?.let { out += PhoneStreamEvent.Text(it) }
        o["choices"]?.jsonArray?.forEach { c ->
            val choice = c.jsonObject
            choice["delta"]?.jsonObject?.get("content")?.jsonPrimitive?.contentOrNull?.let { out += PhoneStreamEvent.Text(it) }
            if (choice["finish_reason"]?.jsonPrimitive?.contentOrNull != null) { done = true; out += PhoneStreamEvent.Done }
        }
        return out
    }
}
