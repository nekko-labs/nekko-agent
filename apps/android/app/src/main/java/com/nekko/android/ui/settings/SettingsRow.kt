package com.nekko.android.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.theme.Nekko

/**
 * A row inside a settings card: icon, title, optional detail, and a chevron when it opens
 * something. Same paddings as the Appearance choices, so the cards line up.
 */
@Composable
fun SettingsRow(
    title: String,
    detail: String? = null,
    icon: ImageVector? = null,
    onClick: (() -> Unit)? = null,
) {
    val p = Nekko.palette
    val base = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
    Row(
        (if (onClick != null) base.clickable(role = Role.Button, onClick = onClick) else base)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
        }
        if (onClick != null) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(20.dp))
        }
    }
}
