package com.nekko.android

import com.nekko.android.ui.chat.PhotoDecoder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhotoDecoderTest {
    @Test fun `reads the bytes of an image data URL only`() {
        assertArrayEquals(byteArrayOf(65), PhotoDecoder.bytesOf("data:image/jpeg;base64,QQ=="))
        assertNull(PhotoDecoder.bytesOf(""))
        assertNull(PhotoDecoder.bytesOf("data:text/plain;base64,QQ=="))
        assertNull(PhotoDecoder.bytesOf("data:image/jpeg,QQ=="))
        assertNull(PhotoDecoder.bytesOf("data:image/jpeg;base64,***"))
    }

    @Test fun `samples down by powers of two, never below the target`() {
        assertEquals(1, PhotoDecoder.sampleSize(384, 216, 384))
        assertEquals(1, PhotoDecoder.sampleSize(1600, 700, 384))
        assertEquals(2, PhotoDecoder.sampleSize(1600, 900, 384))
        assertEquals(4, PhotoDecoder.sampleSize(4000, 3000, 384))
    }
}
