package com.nekko.android.chat

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Photos for a prompt, as the iPhone app sends them: at most [MAX] JPEG data
 * URLs, the long side scaled to [MAX_SIDE] px, so a few of them stay well
 * under the relay's frame cap. The photo picker hands out a read grant for
 * the chosen items only; nothing is kept after the prompt is sent.
 */
object ImageAttachments {
    const val MAX = 4
    const val MAX_SIDE = 1600
    private const val QUALITY = 80

    /** The size a [w]×[h] photo is sent at: never larger than it is. */
    fun fit(w: Int, h: Int, maxSide: Int = MAX_SIDE): Pair<Int, Int> {
        val long = max(w, h)
        if (long <= maxSide || long == 0) return w to h
        val scale = maxSide.toDouble() / long
        return max(1, (w * scale).roundToInt()) to max(1, (h * scale).roundToInt())
    }

    fun dataUrl(jpeg: ByteArray): String = "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(jpeg)

    /** Photos that can't be read (gone, not an image) are skipped. */
    suspend fun load(resolver: ContentResolver, uris: List<Uri>): List<String> = withContext(Dispatchers.IO) {
        uris.take(MAX).mapNotNull { uri ->
            runCatching {
                val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                    val (w, h) = fit(info.size.width, info.size.height)
                    decoder.setTargetSize(w, h)
                    // Software bitmaps can be compressed; hardware ones can't.
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                }
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
                bitmap.recycle()
                dataUrl(out.toByteArray())
            }.getOrNull()
        }
    }
}
