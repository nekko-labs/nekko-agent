import { describe, expect, it } from 'vitest';
import { monitorPickup } from './monitorPickup.js';
const press = { pointerId: 1, clientX: 20, clientY: 30 };
describe('monitor pickup', () => {
  it('does not lift for a press or stationary move', () => {
    const p = monitorPickup();
    expect(p.consume('hardware')).toBeFalsy();
    p.arm('hardware', press); p.move(press);
    expect(p.consume('hardware')).toBeFalsy();
  });
  it('requires movement from the same pointer and consumes it once', () => {
    const p = monitorPickup(); p.arm('hardware', press);
    p.move({ ...press, pointerId: 2, clientX: 25 });
    expect(p.consume('hardware')).toBeFalsy();
    p.arm('hardware', press); p.move({ ...press, clientX: 21 });
    expect(p.consume('hardware')).toBe(true);
    expect(p.consume('hardware')).toBeFalsy();
  });
  it('cannot lift another monitor', () => {
    const p = monitorPickup(); p.arm('hardware', press); p.move({ ...press, clientY: 31 });
    expect(p.consume('budget')).toBe(false);
  });
  it('clears pending movement on release, cancellation, blur, or cleanup', () => {
    const p = monitorPickup();
    p.arm('hardware', press); p.move({ ...press, clientY: 31 }); p.release(press);
    expect(p.consume('hardware')).toBeFalsy();
    p.arm('hardware', press); p.move({ ...press, clientY: 31 }); p.reset();
    expect(p.consume('hardware')).toBeFalsy();
  });
});
