package com.nekko.android.connection

import android.content.Context
import androidx.car.app.connection.CarConnection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether this phone is in a car on Android Auto right now (#2782). Only then does a finished
 * reply's notification carry its words, for the car to read aloud; off the car the phone's
 * notifications never do.
 */
class CarMode(context: Context) {
    private val _inCar = MutableStateFlow(false)
    val inCar: StateFlow<Boolean> = _inCar.asStateFlow()

    init {
        // LiveData: observed for the life of the process, from the main thread.
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            runCatching { CarConnection(context).type.observeForever { _inCar.value = it == CarConnection.CONNECTION_TYPE_PROJECTION } }
        }
    }

    /** Tests only: as if the phone were (or weren't) on Android Auto. */
    fun pretend(inCar: Boolean) { _inCar.value = inCar }
}
