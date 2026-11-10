package com.nekko.android.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.theme.Nekko
import kotlinx.coroutines.CancellationException

/** The existing authorized session:photo read. No path, external URL or file API fallback. */
val LocalSessionPhoto = staticCompositionLocalOf<(suspend (messageId: String, index: Int) -> String?)?> { null }

@Composable
fun ReplyPhotos(messageId: String, thumbs: List<String>) {
    val read = LocalSessionPhoto.current
    var opened by remember(messageId) { mutableStateOf<Int?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        thumbs.forEachIndexed { index, thumb ->
            Box(Modifier.testTag("image.reply.$index").clickable(enabled = read != null) { opened = index }) {
                PromptPhotos(listOf(thumb), Nekko.palette.inkSoft, Nekko.palette.surface2)
            }
            TextButton(onClick = { opened = index }, enabled = read != null) { Text(stringResource(R.string.image_reply_n, index + 1)) }
        }
    }
    val index = opened
    if (index != null && read != null) {
        val unavailable = stringResource(R.string.image_unavailable)
        var error by remember(messageId, index) { mutableStateOf<String?>(null) }
        var loaded by remember(messageId, index) { mutableStateOf(false) }
        val bitmap by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, messageId, index) {
            try {
                val url = read(messageId, index)
                value = url?.let { PhotoDecoder.decode(it, targetPx = 2048) }
                if (value == null) error = unavailable
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message ?: unavailable }
            finally { loaded = true }
        }
        AlertDialog(onDismissRequest = { opened = null }, title = { Text(stringResource(R.string.image_reply_n, index + 1)) }, text = {
            Column {
                val image = bitmap
                if (image != null) Image(image, stringResource(R.string.image_reply_n, index + 1), contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 560.dp).testTag("image.full"))
                else if (!loaded) CircularProgressIndicator()
                error?.let { Text(it, color = Nekko.palette.danger) }
            }
        }, confirmButton = { TextButton(onClick = { opened = null }) { Text(stringResource(R.string.image_close)) } })
    }
}
