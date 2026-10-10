import { describe, expect, it } from 'vitest';
import { shouldTrackDocument } from '../../src/documentScope';

describe('document sync scope', () => {
  it('tracks every workspace document', () => {
    expect(shouldTrackDocument({ inWorkspace: true, dirty: false, tracked: false })).toBe(true);
  });

  it('ignores a clean library file outside the workspace (opening lib.dom.d.ts is not a change)', () => {
    expect(shouldTrackDocument({ inWorkspace: false, dirty: false, tracked: false })).toBe(false);
  });

  it('tracks an outside file once it has unsaved edits, and keeps tracking it', () => {
    expect(shouldTrackDocument({ inWorkspace: false, dirty: true, tracked: false })).toBe(true);
    expect(shouldTrackDocument({ inWorkspace: false, dirty: false, tracked: true })).toBe(true);
  });
});
