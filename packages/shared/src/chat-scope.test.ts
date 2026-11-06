import { describe, expect, it } from 'vitest';
import { chatEffort } from './chat-scope.js';

describe('chat scope', () => {
  it('lets a chat effort win over the app-wide one', () => {
    expect(chatEffort({}, 'high')).toBe('high');
    expect(chatEffort({ effort: 'low' }, 'high')).toBe('low');
    expect(chatEffort({ effort: null as never }, 'high')).toBe('high');
    expect(chatEffort(undefined, undefined)).toBeUndefined();
  });
});
