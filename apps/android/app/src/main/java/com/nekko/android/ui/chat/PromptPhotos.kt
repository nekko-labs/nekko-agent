package com.nekko.android.ui.chat

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The photos of a prompt in its bubble: the computer's thumbnails, or the
 * photos just sent while the turn runs. A photo the phone has no picture for
 * (`""`: older than the newest ones, or not an image the computer could read)
 * is a plain tile, so the count stays right.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PromptPhotos(thumbs: List<String>, tint: Color, tile: Color) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        thumbs.forEachIndexed { i, url ->
            val bitmap by produceState<ImageBitmap?>(null, url) { value = PhotoDecoder.decode(url) }
            val shape = RoundedCornerShape(10.dp)
            val label = if (url.isEmpty()) "Photo ${i + 1}, on the computer" else "Photo ${i + 1}"
            val b = bitmap
            if (b != null) {
                Image(
                    b,
                    contentDescription = label,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(SIDE.dp).clip(shape),
                )
            } else {
                Box(
                    Modifier.size(SIDE.dp).clip(shape).background(tile).semantics { contentDescription = label },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.Image, contentDescription = null, tint = tint, modifier = Modifier.size(24.dp))
                }
            }
        }
    }
}

private const val SIDE = 96

/** Image data URLs → small bitmaps, off the main thread, remembered by URL. */
object PhotoDecoder {
    private const val TARGET_PX = 384
    private val cache = object : LruCache<String, ImageBitmap>(16 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }

    /** Null for `""`, a data URL that isn't base64, or bytes Android can't decode. */
    suspend fun decode(url: String): ImageBitmap? {
        if (url.isEmpty()) return null
        cache.get(url)?.let { return it }
        return withContext(Dispatchers.Default) {
            val bytes = bytesOf(url) ?: return@withContext null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, TARGET_PX) }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()?.also { cache.put(url, it) }
        }
    }

    /** The bytes of a `data:image/…;base64,` URL, or null. */
    fun bytesOf(url: String): ByteArray? {
        if (!url.startsWith("data:image/")) return null
        val comma = url.indexOf(";base64,")
        if (comma < 0) return null
        return runCatching { Base64.getDecoder().decode(url.substring(comma + 8)) }.getOrNull()
    }

    /** The largest power of two that keeps both sides at least [target] px (BitmapFactory's inSampleSize). */
    fun sampleSize(w: Int, h: Int, target: Int): Int {
        var n = 1
        while (w / (n * 2) >= target && h / (n * 2) >= target) n *= 2
        return n
    }
}
