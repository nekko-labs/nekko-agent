package com.nekko.android.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.data.StarAsk
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.theme.Nekko

object StarAskTags {
    const val CARD = "chat.starAsk"
    const val STAR = "chat.starAsk.star"
    const val LATER = "chat.starAsk.later"
    const val NEVER = "chat.starAsk.never"
    const val CLOSE = "chat.starAsk.close"
}

/**
 * The GitHub star ask under the 10th and 50th reply (spec/platform/github-star-ask.md), inline in
 * the transcript, never a dialog. The phone has no GitHub connector, so Star on GitHub opens the
 * repository in the browser and says thank you; it never claims a star was made.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StarAskCard(thanked: Boolean, onStar: () -> Unit, onLater: () -> Unit, onNever: () -> Unit, onClose: () -> Unit) {
    val p = Nekko.palette
    val uri = LocalUriHandler.current
    NCard(Modifier.testTag(StarAskTags.CARD)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Outlined.Star, contentDescription = null, tint = p.inkSoft, modifier = Modifier.padding(top = 2.dp).size(20.dp))
            Column(Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    stringResource(if (thanked) R.string.chat_star_thanks else R.string.chat_star_title),
                    style = MaterialTheme.typography.titleSmall,
                    color = p.ink,
                )
                Text(
                    stringResource(if (thanked) R.string.chat_star_thanks_detail else R.string.chat_star_detail),
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkSoft,
                )
            }
            if (thanked) {
                IconButton(onClick = onClose, modifier = Modifier.size(32.dp).testTag(StarAskTags.CLOSE)) {
                    Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.tools_close), tint = p.inkFaint, modifier = Modifier.size(16.dp))
                }
            }
        }
        if (!thanked) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                Button(
                    onClick = {
                        // No browser is the only way this throws; the thank-you still stands for the intent.
                        runCatching { uri.openUri(StarAsk.REPO_URL) }
                        onStar()
                    },
                    modifier = Modifier.heightIn(min = 48.dp).testTag(StarAskTags.STAR),
                ) {
                    Icon(Icons.Outlined.Star, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.chat_star_on_github), modifier = Modifier.padding(start = 8.dp))
                }
                OutlinedButton(onClick = onLater, modifier = Modifier.heightIn(min = 48.dp).testTag(StarAskTags.LATER)) {
                    Text(stringResource(R.string.chats_not_now))
                }
                TextButton(onClick = onNever, modifier = Modifier.heightIn(min = 48.dp).testTag(StarAskTags.NEVER)) {
                    Text(stringResource(R.string.chat_star_never), color = p.inkSoft)
                }
            }
        }
    }
}
