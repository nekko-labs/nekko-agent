package com.nekko.android.ui.components

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
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
@StringRes
fun computerIconLabel(name: String): Int = when (name) {
    "laptop" -> R.string.computer_icon_name_laptop
    "desktop" -> R.string.computer_icon_name_desktop
    "tower" -> R.string.computer_icon_name_tower
    "mini" -> R.string.computer_icon_name_mini
    "server" -> R.string.computer_icon_name_server
    "rack" -> R.string.computer_icon_name_rack
    "cloud" -> R.string.computer_icon_name_cloud
    "gpu" -> R.string.computer_icon_name_gpu
    "chip" -> R.string.computer_icon_name_chip
    "home" -> R.string.computer_icon_name_home
    "office" -> R.string.computer_icon_name_office
    "lab" -> R.string.computer_icon_name_lab
    "bolt" -> R.string.computer_icon_name_bolt
    "moon" -> R.string.computer_icon_name_moon
    "sun" -> R.string.computer_icon_name_sun
    "star" -> R.string.computer_icon_name_star
    "flame" -> R.string.computer_icon_name_flame
    "leaf" -> R.string.computer_icon_name_leaf
    "globe" -> R.string.computer_icon_name_globe
    "cube" -> R.string.computer_icon_name_cube
    "rocket" -> R.string.computer_icon_name_rocket
    "shield" -> R.string.computer_icon_name_shield
    "terminal" -> R.string.computer_icon_name_terminal
    "cat" -> R.string.computer_icon_name_cat
    else -> R.string.computer_icon_none
}

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
