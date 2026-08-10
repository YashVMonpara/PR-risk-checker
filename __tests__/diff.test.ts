import { parsePatch, getAddedLines, calculatePosition } from '../src/diff';

// A realistic two-hunk unified diff as GitHub returns it in `file.patch`.
const TWO_HUNK_PATCH = [
  '@@ -1,6 +1,8 @@',
  ' import fs from "fs";',
  ' ',
  '-export function run(cmd) {',
  '-  return cmd;',
  '+export function run(cmd, opts) {',
  '+  return eval(cmd);',
  ' }',
  ' ',
  ' export const VERSION = "1.0";',
  '@@ -20,3 +22,4 @@ export const VERSION = "1.0";',
  ' function helper() {',
  '   return 1;',
  '+  // trailing note',
  ' }',
].join('\n');

describe('parsePatch', () => {
  it('extracts both hunks with correct line ranges', () => {
    const hunks = parsePatch(TWO_HUNK_PATCH);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 6, newStart: 1, newLines: 8 });
    expect(hunks[1]).toMatchObject({ oldStart: 20, oldLines: 3, newStart: 22, newLines: 4 });
  });

  it('handles a single-line hunk header without explicit counts', () => {
    const hunks = parsePatch('@@ -0,0 +1 @@\n+hello');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ newStart: 1, newLines: 1 });
  });

  it('returns an empty array for empty or malformed input', () => {
    expect(parsePatch('')).toEqual([]);
    expect(parsePatch('not a diff at all')).toEqual([]);
  });
});

describe('getAddedLines', () => {
  it('returns only added lines with correct new-file line numbers', () => {
    const added = getAddedLines(TWO_HUNK_PATCH);
    expect(added.map((a) => a.content)).toEqual([
      'export function run(cmd, opts) {',
      '  return eval(cmd);',
      '  // trailing note',
    ]);
    // Hunk 1 starts at new line 1: context(1), context(2), then two additions at 3 and 4.
    expect(added[0].lineNumber).toBe(3);
    expect(added[1].lineNumber).toBe(4);
    // Hunk 2 starts at new line 22: context(22), context(23), addition at 24.
    expect(added[2].lineNumber).toBe(24);
  });

  it('assigns diff positions counting every line after the first hunk header', () => {
    const added = getAddedLines(TWO_HUNK_PATCH);
    // Position 1 is the line right after the first "@@". The two "+" lines are
    // the 5th and 6th lines after it.
    expect(added[0].position).toBe(5);
    expect(added[1].position).toBe(6);
    // The second hunk header itself also consumes a position (10), so the
    // addition inside it lands at 13.
    expect(added[2].position).toBe(13);
  });

  it('ignores the +++ file header line', () => {
    const patch = '--- a/x.js\n+++ b/x.js\n@@ -1 +1,2 @@\n test\n+added';
    const added = getAddedLines(patch);
    expect(added).toHaveLength(1);
    expect(added[0].content).toBe('added');
  });

  it('returns an empty array when there are no additions', () => {
    expect(getAddedLines('@@ -1,2 +1,1 @@\n keep\n-gone')).toEqual([]);
  });
});

describe('calculatePosition', () => {
  it('maps a new-file line number to its diff position', () => {
    expect(calculatePosition(TWO_HUNK_PATCH, 3)).toBe(5);
    expect(calculatePosition(TWO_HUNK_PATCH, 4)).toBe(6);
    expect(calculatePosition(TWO_HUNK_PATCH, 24)).toBe(13);
  });

  it('maps context lines too', () => {
    // New line 1 is the first context line, immediately after the "@@".
    expect(calculatePosition(TWO_HUNK_PATCH, 1)).toBe(1);
  });

  it('returns null for a line that is not present in the diff', () => {
    expect(calculatePosition(TWO_HUNK_PATCH, 999)).toBeNull();
    expect(calculatePosition(TWO_HUNK_PATCH, 15)).toBeNull();
  });

  it('returns null for an empty patch', () => {
    expect(calculatePosition('', 1)).toBeNull();
  });
});
