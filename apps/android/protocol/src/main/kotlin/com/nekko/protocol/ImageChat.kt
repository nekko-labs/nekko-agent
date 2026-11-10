package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/** Local diffusion parameters (shared/chat.ts), never a provider, path or cloud request. */
data class ImageChatParams(
    val modelId: String? = null,
    val width: Double = 1024.0,
    val height: Double = 1024.0,
    val steps: Double = 28.0,
    val cfgScale: Double = 4.0,
    val seed: Double = -1.0,
) {
    // Keep decoded numbers intact: ChangeProof supports integers only. Never round a saved CFG.
    val valid: Boolean get() = integer(width, 256.0, 2048.0) && width % 64 == 0.0 &&
        integer(height, 256.0, 2048.0) && height % 64 == 0.0 && integer(steps, 1.0, 100.0) &&
        integer(cfgScale, 0.0, 30.0) && integer(seed, -1.0, 2_147_483_647.0)

    fun json(): JsonObject {
        require(valid) { INVALID }
        return buildJsonObject {
            modelId?.let { put("modelId", it) }
            put("width", width.toLong()); put("height", height.toLong()); put("steps", steps.toLong())
            put("cfgScale", cfgScale.toLong()); put("seed", seed.toLong())
        }
    }

    fun sessionOptions(): JsonObject = buildJsonObject { put("chatType", "image"); put("imageParams", json()) }
    fun generation(sessionId: String, prompt: String): JsonObject = buildJsonObject {
        put("sessionId", sessionId); put("prompt", prompt); put("params", json())
    }

    companion object {
        const val INVALID = "Image settings need whole numbers: size 256–2048 in steps of 64, steps 1–100, CFG 0–30, seed -1–2147483647. Fractional saved settings cannot be signed; choose whole numbers explicitly."
        private fun integer(n: Double, min: Double, max: Double) = n.isFinite() && n in min..max && n % 1 == 0.0
        fun from(e: JsonElement?): ImageChatParams? {
            val o = e.obj() ?: return null
            // A desktop session missing cfgScale uses the desktop's fractional default (4.5).
            // Do not silently replace that intent with this phone's new-chat default (4).
            fun number(key: String, default: Double) = if (!o.containsKey(key)) default
                else (o[key] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull ?: Double.NaN
            return ImageChatParams(o.str("modelId"), number("width", 1024.0), number("height", 1024.0),
                number("steps", 28.0), number("cfgScale", 4.5), number("seed", -1.0))
        }
    }
}

/** Only the phone-safe image-model fields of engine:models survive decoding. */
data class ImageChatModel(val id: String, val name: String, val kind: String, val format: String?, val state: String?) {
    companion object {
        fun list(e: JsonElement?): List<ImageChatModel> = e.arr()?.mapNotNull { v ->
            val o = v.obj() ?: return@mapNotNull null
            val id = o.str("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            if (o.str("kind") != "image") return@mapNotNull null
            ImageChatModel(id, o.str("name") ?: id, "image", o.str("format"), o.str("state"))
        }.orEmpty()
    }
}
