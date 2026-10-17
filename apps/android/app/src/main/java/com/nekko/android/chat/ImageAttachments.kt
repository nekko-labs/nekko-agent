package com.nekko.android.chat

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.scale
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Photos for a prompt, as the iPhone app sends them: at most [MAX] JPEG data
 * URLs, the long side scaled to [MAX_SIDE] px, so a few of them stay well
 * under the relay's frame cap. The photo picker hands out a read grant for
 * the chosen items only; nothing is kept after the prompt is sent.
 * The composer holds them in a [PhotoTray] until then.
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

    /**
     * One picked or taken photo: its data URL and a small preview for the
     * composer's thumbnail. Runs off the main thread; throws when the file is
     * not an image Android can read. ImageDecoder applies the EXIF rotation, so
     * a portrait camera shot stays upright.
     */
    suspend fun encode(resolver: ContentResolver, uri: Uri): Pair<String, ImageBitmap> = withContext(Dispatchers.IO) {
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
            val (w, h) = fit(info.size.width, info.size.height)
            decoder.setTargetSize(w, h)
            // Software bitmaps can be compressed; hardware ones can't.
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        val out = ByteArrayOutputStream()
        check(bitmap.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)) { "Couldn’t read that image." }
        val (pw, ph) = fit(bitmap.width, bitmap.height, PREVIEW_SIDE)
        // scale() returns the same bitmap when it is already small enough; only free a separate full-size one.
        val preview = bitmap.scale(pw, ph)
        if (preview !== bitmap) bitmap.recycle()
        dataUrl(out.toByteArray()) to preview.asImageBitmap()
    }

    private const val PREVIEW_SIDE = 192
}
