import { seedTable } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { initialState } from '../src/state';
import { CHORDONOMICON_ATTRIBUTION, tableAttribution, tableSummary } from '../src/views/toolbar';

describe('tableSummary', () => {
  it('names the active table and the section count of the current mode', () => {
    const summary = tableSummary(initialState());
    expect(summary.startsWith('seed · ')).toBe(true);
    expect(summary).toContain('sections (major)');
  });

  it('says when the table has no data for the mode', () => {
    const state = initialState();
    state.song.key.mode = 'dorian';
    expect(tableSummary(state)).toBe('seed · no data for dorian');
  });
});

describe('tableAttribution', () => {
  it('shows the one Chordonomicon attribution line for tables built from it', () => {
    expect(tableAttribution({ name: 'chordonomicon', license: 'CC BY-NC 4.0' })).toBe(
      CHORDONOMICON_ATTRIBUTION,
    );
    expect(tableAttribution({ name: 'Chordonomicon-pop' })).toBe(CHORDONOMICON_ATTRIBUTION);
  });

  it('falls back to the licence the table declares, or nothing', () => {
    expect(tableAttribution({ name: 'own', license: 'MIT' })).toBe('License: MIT');
    expect(tableAttribution(seedTable.source)).toBeUndefined();
  });
});
