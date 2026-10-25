package com.nekko.android.data

import com.nekko.protocol.PaneLayout

/**
 * The folding-phone pane arrangement, remembered per computer on the phone only
 * (spec/phone/folding-phones-two-chats-and-monitors.md, *Panes*): what each pane
 * held, the divider and which pane had the keyboard, restored when the phone is
 * opened. Kept in [PhonePrefs], like [NewChatDefaults]; nothing goes to the computer.
 */
class PaneLayouts(private val prefs: PhonePrefs) {
    /** The last arrangement on [computerId], or the first-open default (*Chats + Chat*). */
    fun get(computerId: String): PaneLayout = PaneLayout.decodeAll(prefs.get(LAYOUTS))[computerId] ?: PaneLayout.DEFAULT

    fun set(computerId: String, layout: PaneLayout) {
        val next = PaneLayout.decodeAll(prefs.get(LAYOUTS)).toMutableMap()
        if (next[computerId] == layout.copy(zoomed = null)) return
        next[computerId] = layout
        prefs.set(LAYOUTS, PaneLayout.encodeAll(next))
    }

    /** A computer was forgotten: drop its arrangement. */
    fun forget(computerId: String) {
        val next = PaneLayout.decodeAll(prefs.get(LAYOUTS)).toMutableMap()
        if (next.remove(computerId) == null) return
        if (next.isEmpty()) prefs.reset(LAYOUTS) else prefs.set(LAYOUTS, PaneLayout.encodeAll(next))
    }

    /** Whether the one-time *Chat + Chat* tip has been offered on this phone. */
    var tipShown: Boolean
        get() = prefs.get(CHAT_CHAT_TIP)
        set(value) = prefs.set(CHAT_CHAT_TIP, value)

    companion object {
        /** `computerId\tfirst\tsecond\tsplit\tfocused` lines ([PaneLayout.encodeAll]). */
        val LAYOUTS = PhonePrefs.string("panes.layouts", default = "")

        /** The first time a second chat opens over a running one, a one-line tip offers *Chat + Chat*; once. */
        val CHAT_CHAT_TIP = PhonePrefs.boolean("panes.chatChatTipShown", default = false)

        /** The untested-on-a-foldable footnote was dismissed on this phone (it stays in the Replace with… menu). */
        val FOLDABLE_NOTE_DISMISSED = PhonePrefs.boolean("panes.foldableNoteDismissed", default = false)
    }
}
