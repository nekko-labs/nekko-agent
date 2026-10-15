package com.nekko.android.voice

import android.content.Context

/** [MicHardware] on a real phone: [Recorder] for the computer, [PhoneRecognizer] for the phone engine. */
class AndroidMic(context: Context) : MicHardware {
    private val recorder = Recorder()
    private val phone = PhoneRecognizer(context.applicationContext)

    override suspend fun record(onProgress: (samples: Int, level: Float) -> Unit): ShortArray =
        recorder.record { n, lvl -> onProgress(n, lvl) }

    override fun stopRecording() = recorder.stop()

    override fun phoneAvailable(): Boolean = phone.available()

    override suspend fun phoneListen(language: String, onLevel: (Float) -> Unit): String = phone.listen(language, onLevel)

    override fun stopPhone() = phone.stop()
}
