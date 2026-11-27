package com.nekko.android.data

import com.nekko.android.R

enum class PlanDisplay(val label: Int) {
    FULL(R.string.plan_display_full), BALANCED(R.string.plan_display_balanced),
    ONE(R.string.plan_display_one), HIDDEN(R.string.plan_display_hidden);

    companion object { val KEY = PhonePrefs.enum("planDisplay", BALANCED) }
}
