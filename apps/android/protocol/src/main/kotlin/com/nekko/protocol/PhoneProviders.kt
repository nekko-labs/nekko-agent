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
        // Mantle Messages uses x-api-key, not the OpenAI route's Authorization header.
        Kind("bedrock", "Claude in Amazon Bedrock", "https://bedrock-mantle.us-east-1.api.aws/anthropic", claude.filterNot { it.id == "claude-sonnet-4-6" }.map { it.copy(id = "anthropic.${it.id}") }, hint = "Bedrock bearer token. Set your region in the address."),
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
        require(uri != null && uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && (uri.port == -1 || uri.port in 1..65535) && !url.contains("YOUR_") && !Regex("(?i)%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)").containsMatchIn(url) && uri.path.split('/').none { it == "." || it == ".." }) { "Use a full HTTPS address without credentials, query, fragment or traversal." }
        require(k.keyOptional || !key.isNullOrBlank()) { "Paste the key." }
        require(workspaceId?.any { it.code !in 32..126 } != true) { "The workspace ID must contain only printable ASCII." }
        require(key?.any { it.code !in 32..126 } != true) { "The key must contain only printable ASCII." }
        return PhoneProvider(id, kind, label.trim(), url, workspaceId?.trim()?.ifEmpty { null }?.takeIf { kind == "anthropic" })
    }
    private fun anthropic(p: PhoneProvider) = p.kind in setOf("anthropic", "bedrock", "foundry", "vertex")
    private fun headers(p: PhoneProvider, key: String?): Map<String, String> = buildMap {
        put("Content-Type", "application/json")
        if (p.kind in setOf("anthropic", "bedrock", "foundry")) put("x-api-key", key.orEmpty().trim())
        else if (!key.isNullOrBlank()) put("Authorization", "Bearer ${key.trim()}")
        if (anthropic(p) && p.kind != "vertex") put("anthropic-version", "2023-06-01")
        if (p.kind == "anthropic") p.workspaceId?.let { put("anthropic-workspace-id", it.trim()) }
        if (p.kind == "openrouter") put("X-Title", "Nekko Agent")
    }
    // Persisted metadata bypasses make(), so validate again before attaching a key.
    private fun validate(p: PhoneProvider, key: String?) {
        require(p.enabled) { "This provider is disabled." }
        require(p.baseUrl == p.baseUrl.trim()) { "Invalid provider address." }
        make(p.id, p.kind, p.label, p.baseUrl, key, p.workspaceId)
    }
    fun chatRequest(p: PhoneProvider, key: String?, model: String, messages: List<PhoneMessage>, system: String? = "You are Nekko Agent on the user's Android phone. You have no tools and cannot see computers, files or the web. Answer in Markdown.", maxTokens: Int = 8192): PhoneRequest {
        validate(p, key)
        require(maxTokens > 0) { "The reply token limit must be positive." }
        require(model.isNotBlank() && model.length <= 1024 && model.none { it.isISOControl() } && (p.kind != "vertex" || model.matches(Regex("[a-zA-Z0-9_-][a-zA-Z0-9@._-]*")))) { "Invalid model id." }
        val a = anthropic(p)
        val body = buildJsonObject {
            put("stream", true)
            if (p.kind != "vertex") put("model", model)
            put(if (p.kind == "openai") "max_completion_tokens" else "max_tokens", maxTokens)
            if (a) system?.let { put("system", it) }
            if (p.kind == "vertex") put("anthropic_version", "vertex-2023-10-16")
            if (p.kind in setOf("openai", "openrouter")) putJsonObject("stream_options") { put("include_usage", true) }
            putJsonArray("messages") {
                if (!a && system != null) add(buildJsonObject { put("role", "system"); put("content", system) })
                messages.filter { it.text.isNotBlank() && it.role in setOf("user", "assistant") }.forEach { m -> add(buildJsonObject { put("role", m.role); put("content", m.text) }) }
            }
        }
        val path = when { p.kind == "vertex" -> "/publishers/anthropic/models/$model:streamRawPredict"; a -> "/v1/messages"; else -> "/chat/completions" }
        return PhoneRequest(p.baseUrl.trimEnd('/') + path, headers(p, key) + ("Accept" to "text/event-stream"), body)
    }
    fun modelsRequest(p: PhoneProvider, key: String?): PhoneRequest? {
        validate(p, key)
        return if (kind(p.kind)?.catalog?.isNotEmpty() == true) null else PhoneRequest(p.baseUrl.trimEnd('/') + if (p.kind == "anthropic") "/v1/models?limit=1000" else "/models", headers(p, key), method = "GET")
    }
    fun models(body: String, kind: String): List<PhoneModel> {
        require(body.length <= 2_000_000) { "The provider's model list is too large." }
        val data = (Json.parseToJsonElement(body) as? JsonObject)?.get("data") as? JsonArray ?: return emptyList()
        val skip = listOf("embedding", "whisper", "tts", "dall-e", "moderation", "image", "audio", "realtime", "transcribe", "search", "davinci", "babbage", "sora")
        return data.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val id = o.string("id") ?: return@mapNotNull null
            if (id.isBlank() || id.length > 1024 || id.any { it.isISOControl() } || kind == "openai" && skip.any { id.contains(it) }) null else PhoneModel(id, o.string("display_name") ?: o.string("name") ?: id)
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

private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

sealed interface PhoneStreamEvent {
    data class Text(val text: String) : PhoneStreamEvent
    data class Failure(val message: String) : PhoneStreamEvent
    data object Done : PhoneStreamEvent
    /**
     * The token counts the provider reported so far, as totals (the newest wins per field): Anthropic's
     * `message_start` (input with cache writes and reads) and `message_delta` (output, a running total);
     * OpenAI and OpenRouter's last chunk (`prompt_tokens`, `completion_tokens`). For this phone's usage (#2114).
     */
    data class Usage(val input: Long? = null, val output: Long? = null) : PhoneStreamEvent
}

/** SSE frames may contain several data lines. Completion must be explicit, not just EOF. */
class PhoneStreamParser {
    companion object {
        const val MAX_FRAME_CHARS = 1_000_000
        const val MAX_STREAM_CHARS = 8_000_000
        const val MAX_TEXT_CHARS = 2_000_000
    }
    private val data = StringBuilder()
    private var hasData = false
    private var eventType = ""
    private var frameChars = 0
    private var streamChars = 0
    private var textChars = 0
    private var done = false
    private fun fail(message: String = "The provider sent an unreadable stream."): List<PhoneStreamEvent> {
        done = true
        data.clear()
        return listOf(PhoneStreamEvent.Failure(message))
    }
    /** A count is a whole, non-negative number; anything else is not one. */
    private fun count(o: JsonObject?, key: String): Long? = (o?.get(key) as? kotlinx.serialization.json.JsonPrimitive)
        ?.takeIf { !it.isString }?.content?.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }?.toLong()

    private fun usage(o: JsonObject): PhoneStreamEvent.Usage? {
        val u: JsonObject? = when (o.string("type")) {
            "message_start" -> (o["message"] as? JsonObject)?.get("usage") as? JsonObject
            "message_delta" -> o["usage"] as? JsonObject
            else -> o["usage"] as? JsonObject
        }
        u ?: return null
        val anthropicIn = count(u, "input_tokens")?.let { it + (count(u, "cache_creation_input_tokens") ?: 0) + (count(u, "cache_read_input_tokens") ?: 0) }
        val input = anthropicIn ?: count(u, "prompt_tokens")
        val output = count(u, "output_tokens") ?: count(u, "completion_tokens")
        return if (input == null && output == null) null else PhoneStreamEvent.Usage(input, output)
    }

    fun line(line: String): List<PhoneStreamEvent> {
        if (done) return emptyList()
        if (line.length > MAX_FRAME_CHARS || streamChars.toLong() + line.length + 1 > MAX_STREAM_CHARS || frameChars.toLong() + line.length + 1 > MAX_FRAME_CHARS) return fail("The provider's stream is too large.")
        streamChars += line.length + 1
        frameChars += line.length + 1
        if (line.isNotEmpty()) {
            val field = line.substringBefore(':')
            val value = line.substringAfter(':', "").removePrefix(" ")
            if (field == "data") {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
            } else if (field == "event") eventType = value
            return emptyList()
        }
        frameChars = 0
        val type = eventType; eventType = ""
        if (type == "error") return fail("The provider stopped with an error. Test the provider and retry.")
        if (!hasData) return emptyList()
        val value = data.toString(); data.clear(); hasData = false
        if (value == "[DONE]") { done = true; return listOf(PhoneStreamEvent.Done) }
        val o = runCatching { Json.parseToJsonElement(value) as? JsonObject }.getOrNull() ?: return fail()
        if (o["error"] != null && o["error"] != JsonNull || o.string("type") == "error") return fail("The provider stopped with an error. Test the provider and retry.")
        if (o.string("type") == "message_stop") { done = true; return listOf(PhoneStreamEvent.Done) }
        val out = mutableListOf<PhoneStreamEvent>()
        usage(o)?.let { out += it }
        if (o.string("type") == "content_block_delta") {
            val delta = o["delta"] as? JsonObject ?: return fail()
            if (delta.string("type") in listOf(null, "text_delta")) {
                delta.string("text")?.let { out += PhoneStreamEvent.Text(it) }
            }
        }
        if (o["choices"] != null) {
            val choices = o["choices"] as? JsonArray ?: return fail()
            // We request one choice. Never concatenate alternative completions.
            val choice = choices.firstOrNull() as? JsonObject
            if (choices.isNotEmpty() && choice == null) return fail()
            if (choice != null) {
                val delta = choice["delta"]
                if (delta != null && delta != JsonNull && delta !is JsonObject) return fail()
                (delta as? JsonObject)?.string("content")?.let { out += PhoneStreamEvent.Text(it) }
                // finish_reason precedes usage and possibly errors. Only [DONE] ends SSE.
            }
        }
        val added = out.filterIsInstance<PhoneStreamEvent.Text>().sumOf { it.text.length }
        if (textChars.toLong() + added > MAX_TEXT_CHARS) return fail("The provider's reply is too large.")
        textChars += added
        return out
    }
}
