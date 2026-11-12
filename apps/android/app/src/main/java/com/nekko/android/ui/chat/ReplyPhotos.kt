package com.nekko.android.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.theme.Nekko

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
    // Full screen, as a prompt's photos open (#2111): the computer's full image, zoom, Save, Copy, Share.
    opened?.let { start ->
        val label = stringResource(R.string.image_reply_n)
        PhotoViewer(
            thumbs.mapIndexed { i, thumb -> ViewerPhoto(thumb, read?.let { r -> { r(messageId, i) } }) },
            start,
            label = { i -> label.format(i + 1) },
            onDismiss = { opened = null },
        )
    }
}
