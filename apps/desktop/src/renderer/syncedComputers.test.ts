import { describe, expect, it } from 'vitest';
import { syncedComputerColor, type ComputerStatus, type SessionSummary } from '@nekko-agent/shared';
import { connectedTwin, syncedBlock, syncedComputer, syncedHomes, withoutShadowedCopies } from './syncedComputers.js';

const chat = (id: string, extra: Partial<SessionSummary> = {}) => ({ id, title: id, createdAt: 1, updatedAt: 1, ...extra }) as SessionSummary;
const laptop = { deviceId: 'dev-laptop', device: 'Laptop' };
const studio = { deviceId: 'dev-studio', device: 'Studio' };
const gomi = { id: 'gomi1234', name: 'laptop', color: 2, state: 'offline', icon: 'tower' } as ComputerStatus;

describe('chats from other computers through Nekko Cloud (#3143)', () => {
  it('lists each other computer once, in the order the list names them', () => {
    const list = [chat('s_1'), chat('s_2', { home: studio }), chat('s_3', { home: laptop }), chat('s_4', { home: studio })];
    expect(syncedHomes(list)).toEqual([studio, laptop]);
    expect(syncedHomes(list)).toBe(syncedHomes(list));
    expect(syncedHomes([chat('s_1')])).toEqual([]);
  });

  it('names a synced computer in a stable colour, or as the connected computer of the same name', () => {
    expect(syncedComputer(studio, [])).toEqual({ id: 'cloud:dev-studio', name: 'Studio', color: syncedComputerColor('dev-studio') });
    expect(syncedComputerColor('dev-studio')).toBe(syncedComputerColor('dev-studio'));
    expect(syncedComputer({ deviceId: 'x', device: ' ' }, []).name).toBe('Another computer');
    // A connected computer named the same lends its colour, icon and state.
    expect(connectedTwin(laptop, [gomi])).toBe(gomi);
    expect(syncedComputer(laptop, [gomi])).toBe(gomi);
    expect(connectedTwin(studio, [gomi])).toBeNull();
  });

  it('lists a chat once when a connected computer shows it live and Nekko Cloud synced it too', () => {
    const list = [chat('s_1'), chat('s_2', { home: laptop }), chat('@gomi1234:s_2'), chat('s_3', { home: laptop })];
    expect(withoutShadowedCopies(list).map((s) => s.id)).toEqual(['s_1', '@gomi1234:s_2', 's_3']);
    const plain = [chat('s_1'), chat('@gomi1234:s_1')];
    expect(withoutShadowedCopies(plain)).toBe(plain);
  });

  it('says where a copy is from where its composer would be', () => {
    expect(syncedBlock(laptop)).toBe('From Laptop, through Nekko Cloud. Read-only here');
  });
});
