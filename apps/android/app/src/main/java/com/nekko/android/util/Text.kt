package com.nekko.android.util

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalResources
import com.nekko.android.R

/** Markdown stripped to one line for titles and previews (port of `plainText` in markdown.ts). */
fun plainText(src: String): String = src
    .replace(Regex("```[\\w+-]*\\n?"), " ")
    .replace(Regex("`([^`]*)`"), "$1")
    .replace(Regex("\\[([^\\]]+)]\\([^)]*\\)"), "$1")
    .replace(Regex("(\\*\\*|__)(.+?)\\1"), "$2")
    .replace(Regex("(^|[\\s(])[*_]([^*_\\s][^*_]*)[*_](?=[\\s).,!?:;]|$)"), "$1$2")
    .replace(Regex("^\\s{0,3}(#{1,6}|>|[-*+]|\\d+[.)])\\s+", RegexOption.MULTILINE), "")
    .replace(Regex("\\s+"), " ")
    .trim()

/** The units [ago] counts in. */
enum class AgoUnit { MIN, HR, DAY, MONTH, YR }

/**
 * Short relative time, in the desktop's wording ("now", "5 mins", "3 hrs", "2 days").
 * [words] says it: English by default ([localAgo] in the app's language); a null unit is "now".
 */
fun ago(ts: Long, now: Long = System.currentTimeMillis(), words: (AgoUnit?, Long) -> String = ::englishAgo): String {
    val s = maxOf(0L, Math.round((now - ts) / 1000.0))
    if (s < 45) return words(null, 0)
    val m = Math.round(s / 60.0)
    if (m < 60) return words(AgoUnit.MIN, m)
    val h = Math.round(m / 60.0)
    if (h < 24) return words(AgoUnit.HR, h)
    val d = Math.round(h / 24.0)
    if (d < 30) return words(AgoUnit.DAY, d)
    val mo = Math.round(d / 30.0)
    if (mo < 12) return words(AgoUnit.MONTH, mo)
    return words(AgoUnit.YR, Math.round(d / 365.0))
}

private fun englishAgo(unit: AgoUnit?, n: Long): String {
    val (one, many) = when (unit) {
        null -> return "now"
        AgoUnit.MIN -> "min" to "mins"
        AgoUnit.HR -> "hr" to "hrs"
        AgoUnit.DAY -> "day" to "days"
        AgoUnit.MONTH -> "month" to "months"
        AgoUnit.YR -> "yr" to "yrs"
    }
    return "$n ${if (n == 1L) one else many}"
}

/** [ago] in the app's language. */
@Composable
fun localAgo(ts: Long, now: Long = System.currentTimeMillis()): String {
    val r = LocalResources.current
    return ago(ts, now) { unit, n ->
        val one = n == 1L
        val id = when (unit) {
            null -> return@ago r.getString(R.string.util_ago_now)
            AgoUnit.MIN -> if (one) R.string.util_ago_min_one else R.string.util_ago_min_other
            AgoUnit.HR -> if (one) R.string.util_ago_hr_one else R.string.util_ago_hr_other
            AgoUnit.DAY -> if (one) R.string.util_ago_day_one else R.string.util_ago_day_other
            AgoUnit.MONTH -> if (one) R.string.util_ago_month_one else R.string.util_ago_month_other
            AgoUnit.YR -> if (one) R.string.util_ago_yr_one else R.string.util_ago_yr_other
        }
        r.getString(id, n.toInt())
    }
}
