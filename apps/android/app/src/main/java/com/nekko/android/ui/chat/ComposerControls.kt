package com.nekko.android.ui.chat

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.components.PermissionIcon
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.PcSettings.ChatMode

/**
 * The chat's folder after **+**, where the desktop composer has its folder picker (#2448).
 * A phone can't change a chat's folder, so its menu opens the chat's files.
 */
@Composable
fun ComposerFolderChip(name: String, enabled: Boolean, onOpenFiles: () -> Unit) {
    val p = Nekko.palette
    var open by remember { mutableStateOf(false) }
    val label = stringResource(R.string.chats_folder)
    Box {
        Row(
            Modifier
                .heightIn(min = 48.dp)
                .clip(CircleShape)
                .clickable(role = Role.Button) { open = true }
                .padding(horizontal = 8.dp)
                .testTag("composer.folder")
                .semantics(mergeDescendants = true) {
                    contentDescription = label
                    stateDescription = name
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(painterResource(R.drawable.composer_folder), contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(16.dp))
            Text(name, style = MaterialTheme.typography.labelLarge, color = p.ink, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.widthIn(max = 140.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = p.surface) {
            Text(name, style = MaterialTheme.typography.labelMedium, color = p.inkSoft, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chats_files), color = if (enabled) p.ink else p.inkFaint) },
                leadingIcon = { Icon(painterResource(R.drawable.composer_folder), contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(16.dp)) },
                enabled = enabled,
                onClick = { open = false; onOpenFiles() },
                modifier = Modifier.testTag("composer.files"),
            )
        }
    }
}

/** Simple's tool policy as just its icon after the folder, as the desktop composer shows it (#2448). */
@Composable
fun ComposerAsksIcon(mode: ChatMode, enabled: Boolean, onClick: () -> Unit) {
    val name = stringResource(asksTitleRes(mode))
    val label = stringResource(R.string.simple_hint_asks)
    IconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.testTag("chat.asksFirst").semantics {
            contentDescription = label
            stateDescription = name
        },
    ) { PermissionIcon(mode) }
}

/**
 * Chat or Image as two icons at the top right (#2448). The one on shows in the theme's accent
 * on a raised pill; the other rests in soft ink. The pill's colour fades over 200 ms.
 */
@Composable
fun ChatKindToggle(image: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Row(
        modifier
            .clip(CircleShape)
            .background(p.surface2)
            .padding(2.dp)
            .testTag("newChat.kind"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KindSegment(on = !image, icon = R.drawable.composer_chat, label = stringResource(R.string.image_kind_text), tag = "newChat.kind.chat") { onChange(false) }
        KindSegment(on = image, icon = R.drawable.composer_photo, label = stringResource(R.string.image_kind_image), tag = "newChat.kind.image") { onChange(true) }
    }
}

@Composable
private fun KindSegment(on: Boolean, icon: Int, label: String, tag: String, onClick: () -> Unit) {
    val p = Nekko.palette
    val fill by animateColorAsState(if (on) p.surface else p.surface2, tween(200), label = "kind-pill")
    val tint by animateColorAsState(if (on) p.accent else p.inkSoft, tween(200), label = "kind-tint")
    Box(
        Modifier
            .size(width = 48.dp, height = 44.dp)
            .clip(CircleShape)
            .background(fill)
            .selectable(selected = on, role = Role.Tab, onClick = onClick)
            .semantics { contentDescription = label }
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
    }
}
