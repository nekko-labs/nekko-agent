import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Modal } from './primitives/index.js';

/**
 * Camera QR scanner using getUserMedia + jsQR (pure JS, no native plugin, works
 * in the Capacitor webview and mobile browsers). Calls onResult with the decoded
 * text. The native app needs a camera usage description (see apps/ios/Info.plist).
 */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const tick = () => {
          if (stopped) return;
          if (v.readyState >= v.HAVE_ENOUGH_DATA && ctx && v.videoWidth) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height);
            if (code?.data) {
              onResult(code.data);
              return;
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        setError(`Camera unavailable: ${(e as Error).message}`);
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <Modal
      title="Scan a pairing QR code"
      onClose={onClose}
      closeOnScrimClick={false}
      scrim="#000"
      zIndex={60}
      overlayClassName="p-6"
      className="flex w-full flex-col items-center"
    >
      <video ref={videoRef} className="max-h-[70vh] w-full max-w-md rounded-2xl object-cover" muted playsInline />
      <div className="pointer-events-none absolute inset-0 m-auto h-56 w-56 rounded-2xl border-2 border-white/70" style={{ maxHeight: '40vh', maxWidth: '70vw' }} />
      <p className="mt-4 text-center text-[13px] text-white/80">
        {error || 'Point at the QR code in Settings → Remote access on your computer.'}
      </p>
      <button className="btn btn-outline mt-4 text-white!" style={{ borderColor: 'rgba(255,255,255,0.4)' }} onClick={onClose}>
        Cancel
      </button>
    </Modal>
  );
}
