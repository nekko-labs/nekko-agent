// A press arms native dragging; only movement of that pointer authorizes lift.
// Keep this separate from dragstart coordinates, which can be the press origin.
export function monitorPickup() {
  let pending: { key: string; pointerId: number; x: number; y: number; moved: boolean } | null = null;
  return {
    arm(key: string, e: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>) {
      pending = { key, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    },
    move(e: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>) {
      if (pending?.pointerId === e.pointerId && (pending.x !== e.clientX || pending.y !== e.clientY)) pending.moved = true;
    },
    release(e: Pick<PointerEvent, 'pointerId'>) { if (pending?.pointerId === e.pointerId) pending = null; },
    reset() { pending = null; },
    consume(key: string) {
      const ready = pending?.key === key && pending.moved;
      pending = null;
      return ready;
    },
  };
}
