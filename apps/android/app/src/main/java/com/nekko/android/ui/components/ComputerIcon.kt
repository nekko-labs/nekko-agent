package com.nekko.android.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.nekko.android.R

/** The drawable for a `machineIcon`, written out so the shrinker keeps all 24. Null for none, or one this app doesn't draw. */
@DrawableRes
fun computerIconRes(name: String?): Int? = when (name) {
    "laptop" -> R.drawable.computer_icon_laptop
    "desktop" -> R.drawable.computer_icon_desktop
    "tower" -> R.drawable.computer_icon_tower
    "mini" -> R.drawable.computer_icon_mini
    "server" -> R.drawable.computer_icon_server
    "rack" -> R.drawable.computer_icon_rack
    "cloud" -> R.drawable.computer_icon_cloud
    "gpu" -> R.drawable.computer_icon_gpu
    "chip" -> R.drawable.computer_icon_chip
    "home" -> R.drawable.computer_icon_home
    "office" -> R.drawable.computer_icon_office
    "lab" -> R.drawable.computer_icon_lab
    "bolt" -> R.drawable.computer_icon_bolt
    "moon" -> R.drawable.computer_icon_moon
    "sun" -> R.drawable.computer_icon_sun
    "star" -> R.drawable.computer_icon_star
    "flame" -> R.drawable.computer_icon_flame
    "leaf" -> R.drawable.computer_icon_leaf
    "globe" -> R.drawable.computer_icon_globe
    "cube" -> R.drawable.computer_icon_cube
    "rocket" -> R.drawable.computer_icon_rocket
    "shield" -> R.drawable.computer_icon_shield
    "terminal" -> R.drawable.computer_icon_terminal
    "cat" -> R.drawable.computer_icon_cat
    else -> null
}

/** A picker's spoken name for an icon. */
fun computerIconLabel(name: String): String = if (name == "gpu") "GPU" else name.replaceFirstChar { it.uppercase() }

/** A computer's icon beside its name, or nothing at all when it has none. Decorative: the name says which. */
@Composable
fun ComputerIcon(name: String?, modifier: Modifier = Modifier, size: Dp = 16.dp, tint: Color = LocalContentColor.current) {
    val res = computerIconRes(name) ?: return
    Icon(painterResource(res), contentDescription = null, tint = tint, modifier = modifier.size(size))
}

/** The icon in a computer's tile: its own, else the plain computer every tile had. */
@Composable
fun ComputerTileIcon(name: String?, size: Dp, tint: Color) {
    if (computerIconRes(name) != null) ComputerIcon(name, size = size, tint = tint)
    else Icon(Icons.Filled.Computer, contentDescription = null, tint = tint, modifier = Modifier.size(size))
}
