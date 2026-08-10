import { AddedLine, DiffHunk } from './types';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Splits a unified diff into hunks.
 *
 * `headerPosition` is the 1-based diff position of the hunk header line itself,
 * counting from the line after the FIRST hunk header (which is position 1).
 * The first header therefore has headerPosition 0.
 */
export function parsePatch(patch: string): DiffHunk[] {
  if (!patch) return [];

  const hunks: DiffHunk[] = [];
  const lines = patch.split('\n');
  let position = 0;
  let seenFirstHeader = false;

  for (const line of lines) {
    const match = HUNK_HEADER.exec(line);

    if (match) {
      hunks.push({
        oldStart: parseInt(match[1], 10),
        oldLines: match[2] === undefined ? 1 : parseInt(match[2], 10),
        newStart: parseInt(match[3], 10),
        newLines: match[4] === undefined ? 1 : parseInt(match[4], 10),
        headerPosition: seenFirstHeader ? position + 1 : 0,
      });
      if (seenFirstHeader) {
        position += 1;
      } else {
        seenFirstHeader = true;
      }
      continue;
    }

    if (seenFirstHeader) {
      position += 1;
    }
  }

  return hunks;
}

/**
 * Walks a unified diff, yielding a callback for every line that exists in the
 * new version of the file (context and additions), along with its new-file line
 * number and its 1-based diff position.
 */
function walkNewSide(
  patch: string,
  visit: (info: { lineNumber: number; position: number; content: string; added: boolean }) => void
): void {
  if (!patch) return;

  const lines = patch.split('\n');
  let position = 0;
  let newLineNumber = 0;
  let seenFirstHeader = false;

  for (const line of lines) {
    const match = HUNK_HEADER.exec(line);

    if (match) {
      newLineNumber = parseInt(match[3], 10);
      if (seenFirstHeader) {
        position += 1; // the header itself occupies a diff position
      } else {
        seenFirstHeader = true;
      }
      continue;
    }

    if (!seenFirstHeader) continue; // skip ---/+++ preamble

    position += 1;
    const marker = line[0];
    const content = line.slice(1);

    if (marker === '+') {
      visit({ lineNumber: newLineNumber, position, content, added: true });
      newLineNumber += 1;
    } else if (marker === '-') {
      // removed lines exist only on the old side; they still consume a position
    } else if (marker === '\\') {
      // "\ No newline at end of file" — no line on either side
    } else {
      visit({ lineNumber: newLineNumber, position, content, added: false });
      newLineNumber += 1;
    }
  }
}

/** Returns every line added by this patch, with new-file line numbers and diff positions. */
export function getAddedLines(patch: string): AddedLine[] {
  const added: AddedLine[] = [];

  walkNewSide(patch, (info) => {
    if (info.added) {
      added.push({
        lineNumber: info.lineNumber,
        content: info.content,
        position: info.position,
      });
    }
  });

  return added;
}

/**
 * Converts a line number in the new version of a file into the `position` value
 * that GitHub's review-comment API expects.
 *
 * Returns null when the line is not represented in the diff, in which case the
 * caller should fall back to a summary comment.
 */
export function calculatePosition(patch: string, lineNumber: number): number | null {
  let found: number | null = null;

  walkNewSide(patch, (info) => {
    if (found === null && info.lineNumber === lineNumber) {
      found = info.position;
    }
  });

  return found;
}
