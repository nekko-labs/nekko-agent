package com.nekko.android.util

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

/** Short relative time, in the desktop's wording ("now", "5 mins", "3 hrs", "2 days"). */
fun ago(ts: Long, now: Long = System.currentTimeMillis()): String {
    val s = maxOf(0L, Math.round((now - ts) / 1000.0))
    if (s < 45) return "now"
    val m = Math.round(s / 60.0)
    if (m < 60) return "$m ${if (m == 1L) "min" else "mins"}"
    val h = Math.round(m / 60.0)
    if (h < 24) return "$h ${if (h == 1L) "hr" else "hrs"}"
    val d = Math.round(h / 24.0)
    if (d < 30) return "$d ${if (d == 1L) "day" else "days"}"
    val mo = Math.round(d / 30.0)
    if (mo < 12) return "$mo ${if (mo == 1L) "month" else "months"}"
    val y = Math.round(d / 365.0)
    return "$y ${if (y == 1L) "yr" else "yrs"}"
}
