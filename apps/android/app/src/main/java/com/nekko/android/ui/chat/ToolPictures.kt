package com.nekko.android.ui.chat

import android.util.LruCache
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.theme.Nekko
import kotlinx.coroutines.CancellationException

/** Pictures already read, by tool message and index, so a row scrolled back into view does not ask again; "" is a picture the phone may not open (a vector one). */
private val read = LruCache<String, String>(16)

/**
 * The pictures an agent made with `generate_image` or `edit_image` (#2973), under the tool's row.
 * The phone's transcript carries only how many ([count]); each is read from the computer with the
 * authorized `session:photo` call that opens a Photo reply, by message and index, so no picture
 * travels until the row is on screen. A tap opens it full screen. A picture the computer keeps
 * (a vector one) shows nothing here.
 */
@Composable
fun ToolPictures(messageId: String, count: Int) {
    val fetch = LocalSessionPhoto.current ?: return
    val urls = remember(messageId, count) { mutableStateMapOf<Int, String>() }
    LaunchedEffect(messageId, count) {
        for (i in 0 until count) {
            val key = "$messageId#$i"
            val cached = read.get(key)
            if (cached != null) { if (cached.isNotEmpty()) urls[i] = cached; continue }
            try {
                val url = fetch(messageId, i)?.takeIf { it.startsWith("data:image/") }
                read.put(key, url ?: "")
                if (url != null) urls[i] = url
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Offline or an older computer: nothing is cached, so the next time this row shows it asks again.
            }
        }
    }
    val shown = urls.entries.sortedBy { it.key }.map { it.value }
    if (shown.isEmpty()) return
    var opened by remember(messageId) { mutableStateOf<Int?>(null) }
    val p = Nekko.palette
    Column(Modifier.padding(start = 24.dp, top = 4.dp)) {
        PromptPhotos(shown, p.inkSoft, p.surface2, onOpen = { opened = it })
    }
    opened?.let { start ->
        val label = stringResource(R.string.image_reply_n)
        PhotoViewer(shown.map { ViewerPhoto(it) }, start, label = { i -> label.format(i + 1) }, onDismiss = { opened = null })
    }
}
