package com.nekko.android.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.size
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.PcSettings.ChatMode

/** Gentleface 0.3.0 line icons, MIT. Full notice: res/raw/license_gentleface_mit.txt. */
@DrawableRes
internal fun permissionIconRes(mode: ChatMode) = when (mode) {
    ChatMode.ASK -> R.drawable.permission_hand
    ChatMode.GUARDRAILS -> R.drawable.permission_shield_check
    ChatMode.YOLO -> R.drawable.permission_running
}

@Composable
fun PermissionIcon(mode: ChatMode) {
    Icon(painterResource(permissionIconRes(mode)), contentDescription = null, tint = Nekko.palette.inkSoft, modifier = Modifier.size(16.dp))
}
