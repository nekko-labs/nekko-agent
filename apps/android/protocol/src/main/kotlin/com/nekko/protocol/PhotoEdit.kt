package com.nekko.protocol

import java.util.Base64
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/**
 * Photo editing in image chats (#2230, decision 0067: an attached photo means edit; decision 0069:
 * the phone sends it as `images` and `size` inside the signed `chat:generateImage` request). A port
 * of the desktop's photoEdit.ts, by way of the iPhone's PhotoEdit.swift.
 */
data class PixelSize(val width: Int, val height: Int)

/**
 * How a reply's picture was made (`GeneratedImageMeta`), as far as the phone needs it. A clip
 * (`video` set) is an animation from a video model: it is not offered for editing, as on the desktop.
 */
data class GeneratedPicture(val modelId: String? = null, val width: Long? = null, val height: Long? = null, val isClip: Boolean = false) {
    companion object {
        fun from(e: JsonElement?): GeneratedPicture? {
            val o = e.obj() ?: return null
            return GeneratedPicture(o.str("modelId"), o.long("width"), o.long("height"), o["video"].let { it != null && it !is JsonNull })
        }
    }
}

object PhotoEdit {
    /** At most this many photos to edit from (the engine and the phone gate refuse more). */
    const val MAX_PHOTOS = 4
    /** A photo's longest side once attached. */
    const val MAX_EDGE = 1536
    /** The photo types the phone gate takes (`data:image/png|jpeg|webp;base64,`). */
    val TYPES = listOf("image/png", "image/jpeg", "image/webp")
    /** All photos of one request together, in characters: the phone gate's cap (6 MiB). */
    const val MAX_TOTAL_CHARS = 6_291_456

    /** JavaScript's `Math.round`, so sizes match the desktop's to the pixel (halves round up). */
    private fun jsRound(x: Double): Int = floor(x + 0.5).toInt()

    /** `fitWithin`: scaled so the longest side is at most [edge], never enlarged. */
    fun fit(size: PixelSize, edge: Int = MAX_EDGE): PixelSize {
        val longest = max(size.width, size.height)
        if (longest <= 0) return size
        val scale = min(1.0, edge.toDouble() / longest)
        return PixelSize(max(1, jsRound(size.width * scale)), max(1, jsRound(size.height * scale)))
    }

    private fun snap(n: Double) = min(2048, max(256, jsRound(n / 64) * 64))

    /** `editSize`: the photo's shape with about as many pixels as the chat's chosen size, in multiples of 64 (256-2048). */
    fun editSize(photo: PixelSize, chosen: PixelSize): PixelSize {
        if (photo.width <= 0 || photo.height <= 0) return chosen
        val area = chosen.width.toDouble() * chosen.height
        val ratio = photo.width.toDouble() / photo.height
        return PixelSize(snap(sqrt(area * ratio)), snap(sqrt(area / ratio)))
    }

    /**
     * Whether the computer's gate takes this as a photo to edit: a lowercase
     * `data:image/png|jpeg|webp;base64,` prefix, then non-empty standard base64.
     */
    fun accepts(dataUrl: String): Boolean {
        val type = TYPES.firstOrNull { dataUrl.startsWith("data:$it;base64,") } ?: return false
        val body = dataUrl.substring("data:$type;base64,".length)
        val padding = body.takeLastWhile { it == '=' }.length
        if (body.isEmpty() || padding > 2 || padding >= body.length) return false
        return body.dropLast(padding).all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '+' || it == '/' }
    }

    /** Whether these photos together fit the phone gate's cap. */
    fun fitsTotal(images: List<String>): Boolean = images.sumOf { it.length } <= MAX_TOTAL_CHARS

    /** A data URL's pixel size from its PNG, JPEG or WebP header; null when it can't be read. */
    fun size(dataUrl: String): PixelSize? {
        if (!dataUrl.startsWith("data:")) return null
        val comma = dataUrl.indexOf(',').takeIf { it >= 0 } ?: return null
        val bytes = runCatching { Base64.getMimeDecoder().decode(dataUrl.substring(comma + 1)) }.getOrNull() ?: return null
        return size(bytes)
    }

    fun size(b: ByteArray): PixelSize? {
        fun u(i: Int) = b[i].toInt() and 0xFF
        fun be16(i: Int) = u(i) shl 8 or u(i + 1)
        fun be32(i: Int) = be16(i) shl 16 or be16(i + 2)
        fun le16(i: Int) = u(i) or (u(i + 1) shl 8)
        fun le24(i: Int) = le16(i) or (u(i + 2) shl 16)
        val found: PixelSize? = when {
            // PNG: the IHDR chunk right after the signature.
            b.size >= 24 && u(0) == 0x89 && u(1) == 0x50 && u(2) == 0x4E && u(3) == 0x47 -> PixelSize(be32(16), be32(20))
            // JPEG: the first start-of-frame marker.
            b.size >= 4 && u(0) == 0xFF && u(1) == 0xD8 -> {
                var i = 2
                var sof: PixelSize? = null
                while (sof == null && i + 9 < b.size) {
                    if (u(i) != 0xFF) break
                    val marker = u(i + 1)
                    if (marker == 0xFF) { i += 1; continue }
                    if (marker == 0xD8 || marker == 0x01 || marker in 0xD0..0xD7) { i += 2; continue }
                    if (marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) sof = PixelSize(be16(i + 7), be16(i + 5))
                    else i += 2 + be16(i + 2)
                }
                sof
            }
            // WebP: RIFF....WEBP, then a VP8X, VP8L or VP8 chunk.
            b.size >= 30 && String(b, 0, 4, Charsets.US_ASCII) == "RIFF" && String(b, 8, 4, Charsets.US_ASCII) == "WEBP" -> when (String(b, 12, 4, Charsets.US_ASCII)) {
                "VP8X" -> PixelSize(le24(24) + 1, le24(27) + 1)
                "VP8L" -> {
                    val bits = u(21) or (u(22) shl 8) or (u(23) shl 16) or (u(24) shl 24)
                    PixelSize((bits and 0x3FFF) + 1, ((bits shr 14) and 0x3FFF) + 1)
                }
                "VP8 " -> PixelSize(le16(26) and 0x3FFF, le16(28) and 0x3FFF)
                else -> null
            }
            else -> null
        }
        return found?.takeIf { it.width > 0 && it.height > 0 }
    }
}
