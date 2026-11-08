package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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
    /**
     * `chat:generateImage`'s one argument (`ImageTurnOptions`), signed whole by the
     * Change proof. With [images] (photos to edit, decision 0069) it also carries
     * them and `size`: the first photo's shape at this chat's pixel count
     * ([PhotoEdit.editSize]). Without photos neither key is sent.
     */
    fun generation(sessionId: String, prompt: String, images: List<String> = emptyList()): JsonObject {
        require(images.size <= PhotoEdit.MAX_PHOTOS) { PhotoEdit.TOO_MANY }
        require(images.all(PhotoEdit::accepts)) { PhotoEdit.WRONG_TYPE }
        require(PhotoEdit.fits(images)) { PhotoEdit.TOO_LARGE }
        val params = json()
        return buildJsonObject {
            put("sessionId", sessionId); put("prompt", prompt); put("params", params)
            if (images.isNotEmpty()) {
                put("images", JsonArray(images.map(::JsonPrimitive)))
                val chosen = width.toLong() to height.toLong()
                val (w, h) = PhotoEdit.size(images.first())?.let { PhotoEdit.editSize(it, chosen) } ?: chosen
                put("size", buildJsonObject { put("width", w); put("height", h) })
            }
        }
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

/**
 * How a Photo chat reply's picture was made (`GeneratedImageMeta`, shared/chat.ts).
 * A clip ([video]) is an animated picture from a video model: never offered for editing.
 */
data class GeneratedImage(val modelId: String?, val video: Boolean) {
    companion object {
        fun from(e: JsonElement?): GeneratedImage? {
            val o = e.obj() ?: return null
            return GeneratedImage(o.str("modelId"), o["video"].let { it != null && it !is JsonNull })
        }
    }
}

/**
 * The desktop's photoEdit.ts on the phone (decision 0067: an attached photo
 * means edit; decision 0069: the phone sends it on `chat:generateImage`).
 */
object PhotoEdit {
    /** At most this many pictures to edit from (the engine and the phone gate refuse more). */
    const val MAX_PHOTOS = 4
    /** A photo's longest side once attached. */
    const val MAX_EDGE = 1536
    /** The data URL types the phone gate takes. */
    val TYPES = listOf("image/png", "image/jpeg", "image/webp")
    /** All photos of one request together, in data-URL characters: the most the computer takes from a phone (6 MiB). */
    const val MAX_TOTAL_CHARS = 6 * 1024 * 1024
    const val TOO_MANY = "Up to 4 photos to edit at once."
    const val WRONG_TYPE = "Photos to edit must be PNG, JPEG or WebP."
    const val TOO_LARGE = "These photos are too large to send together. Remove one and try again."

    /**
     * Whether the computer's gate takes [dataUrl] as a photo to edit: a lowercase
     * `data:image/png|jpeg|webp;base64,` prefix and non-empty standard base64
     * (no whitespace, at most two trailing `=`).
     */
    fun accepts(dataUrl: String): Boolean {
        val type = TYPES.firstOrNull { dataUrl.startsWith("data:$it;base64,") } ?: return false
        val start = "data:$type;base64,".length
        var end = dataUrl.length
        var pad = 0
        while (end > start && dataUrl[end - 1] == '=' && pad < 2) { end--; pad++ }
        if (end == start) return false
        for (i in start until end) {
            val c = dataUrl[i]
            if (!(c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '+' || c == '/')) return false
        }
        return true
    }

    /** Whether [images] fit the computer's limit for one request from a phone. */
    fun fits(images: List<String>): Boolean = images.sumOf { it.length.toLong() } <= MAX_TOTAL_CHARS

    // Math.round rounds halves up, as JavaScript's does.
    private fun snap(n: Double): Long = (Math.round(n / 64) * 64).coerceIn(256L, 2048L)

    /**
     * `editSize`: the photo's shape with about as many pixels as the chat's
     * [chosen] size, in the multiples of 64 the engine accepts (256-2048).
     */
    fun editSize(photo: Pair<Int, Int>, chosen: Pair<Long, Long>): Pair<Long, Long> {
        val (pw, ph) = photo
        if (!(pw > 0 && ph > 0)) return chosen
        val area = chosen.first.toDouble() * chosen.second
        val ratio = pw.toDouble() / ph
        return snap(Math.sqrt(area * ratio)) to snap(Math.sqrt(area / ratio))
    }

    /** `fitWithin`: scaled so the longest side is at most [max], never enlarged. */
    fun fit(w: Int, h: Int, max: Int = MAX_EDGE): Pair<Int, Int> {
        val scale = minOf(1.0, max.toDouble() / maxOf(w, h, 1))
        return maxOf(1, Math.round(w * scale).toInt()) to maxOf(1, Math.round(h * scale).toInt())
    }

    /** A made picture fit to attach as it is: an accepted type no larger than [MAX_EDGE]. */
    fun attachAsIs(dataUrl: String): Boolean =
        accepts(dataUrl) && size(dataUrl)?.let { (w, h) -> maxOf(w, h) <= MAX_EDGE } == true

    /** A data URL's pixel size from its PNG, JPEG or WebP header; null when it can't be read. */
    fun size(dataUrl: String): Pair<Int, Int>? {
        if (!dataUrl.startsWith("data:")) return null
        val comma = dataUrl.indexOf(',').takeIf { it >= 0 } ?: return null
        // Only the header is needed: decode a prefix (whole 4-character groups) of a large picture.
        val b64 = dataUrl.substring(comma + 1).let { if (it.length > HEADER_CHARS) it.substring(0, HEADER_CHARS) else it }
        val bytes = runCatching { java.util.Base64.getMimeDecoder().decode(b64) }.getOrNull() ?: return null
        return size(bytes)
    }

    // A JPEG's start-of-frame can follow large EXIF blocks; 256 K characters (192 KB) covers them.
    private const val HEADER_CHARS = 256 * 1024

    fun size(b: ByteArray): Pair<Int, Int>? = runCatching { header(b) }.getOrNull()

    private fun header(b: ByteArray): Pair<Int, Int>? {
        fun u(i: Int) = b[i].toInt() and 0xFF
        fun be16(i: Int) = (u(i) shl 8) or u(i + 1)
        fun be32(i: Int) = (be16(i) shl 16) or be16(i + 2)
        fun le16(i: Int) = u(i) or (u(i + 1) shl 8)
        fun le24(i: Int) = le16(i) or (u(i + 2) shl 16)
        // PNG: the IHDR chunk right after the signature.
        if (b.size >= 24 && u(0) == 0x89 && u(1) == 0x50 && u(2) == 0x4E && u(3) == 0x47) return be32(16) to be32(20)
        // JPEG: the first start-of-frame marker.
        if (b.size >= 4 && u(0) == 0xFF && u(1) == 0xD8) {
            var i = 2
            while (i + 9 < b.size) {
                if (u(i) != 0xFF) return null
                val marker = u(i + 1)
                if (marker == 0xFF) { i += 1; continue }
                if (marker == 0xD8 || marker == 0x01 || marker in 0xD0..0xD7) { i += 2; continue }
                if (marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) return be16(i + 7) to be16(i + 5)
                i += 2 + be16(i + 2)
            }
            return null
        }
        // WebP: RIFF....WEBP, then a VP8X, VP8L or VP8 chunk.
        if (b.size >= 30 && String(b, 0, 4, Charsets.US_ASCII) == "RIFF" && String(b, 8, 4, Charsets.US_ASCII) == "WEBP") {
            return when (String(b, 12, 4, Charsets.US_ASCII)) {
                "VP8X" -> (le24(24) + 1) to (le24(27) + 1)
                "VP8L" -> {
                    val bits = u(21) or (u(22) shl 8) or (u(23) shl 16) or (u(24) shl 24)
                    ((bits and 0x3FFF) + 1) to (((bits shr 14) and 0x3FFF) + 1)
                }
                "VP8 " -> (le16(26) and 0x3FFF) to (le16(28) and 0x3FFF)
                else -> null
            }
        }
        return null
    }
}
