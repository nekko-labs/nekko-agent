package com.nekko.android.chat

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.scale
import com.nekko.protocol.PhotoEdit
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
    /** The desktop's JPEG quality for a photo to edit (photoEdit.ts). */
    private const val EDIT_QUALITY = 92

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
    suspend fun encode(resolver: ContentResolver, uri: Uri, forEdit: Boolean = false): Pair<String, ImageBitmap> = withContext(Dispatchers.IO) {
        // A photo to edit in an image chat is scaled as the desktop does (photoEdit.ts): a PNG stays a PNG.
        val png = forEdit && resolver.getType(uri) == "image/png"
        val maxSide = if (forEdit) PhotoEdit.MAX_EDGE else MAX_SIDE
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
            val (w, h) = fit(info.size.width, info.size.height, maxSide)
            decoder.setTargetSize(w, h)
            // Software bitmaps can be compressed; hardware ones can't.
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        compressed(bitmap, png, if (forEdit) EDIT_QUALITY else QUALITY)
    }

    /**
     * A picture the computer made (a data URL), ready to edit: kept as it is when
     * it is an accepted type no larger than [PhotoEdit.MAX_EDGE], else scaled down,
     * a PNG staying a PNG. Throws when it can't be read.
     */
    suspend fun forEdit(source: String): Pair<String, ImageBitmap> = withContext(Dispatchers.Default) {
        if (PhotoEdit.attachAsIs(source)) {
            return@withContext source to (preview(source) ?: error("That picture couldn’t be read."))
        }
        val bytes = Base64.getMimeDecoder().decode(source.substringAfter(','))
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("That picture couldn’t be read.")
        val (w, h) = PhotoEdit.fit(decoded.width, decoded.height)
        val bitmap = decoded.scale(w, h)
        if (bitmap !== decoded) decoded.recycle()
        compressed(bitmap, source.startsWith("data:image/png"), EDIT_QUALITY)
    }

    private fun compressed(bitmap: Bitmap, png: Boolean, quality: Int): Pair<String, ImageBitmap> {
        val out = ByteArrayOutputStream()
        val format = if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
        check(bitmap.compress(format, quality, out)) { "Couldn’t read that image." }
        val (pw, ph) = fit(bitmap.width, bitmap.height, PREVIEW_SIDE)
        // scale() returns the same bitmap when it is already small enough; only free a separate full-size one.
        val preview = bitmap.scale(pw, ph)
        if (preview !== bitmap) bitmap.recycle()
        val url = if (png) "data:image/png;base64," + Base64.getEncoder().encodeToString(out.toByteArray()) else dataUrl(out.toByteArray())
        return url to preview.asImageBitmap()
    }

    /** A saved draft's photo (a data URL this app made) back to a thumbnail; null when it can't be read. */
    fun preview(dataUrl: String): ImageBitmap? = runCatching {
        val bytes = Base64.getDecoder().decode(dataUrl.substringAfter(','))
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= PREVIEW_SIDE) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }.getOrNull()

    private const val PREVIEW_SIDE = 192
}
