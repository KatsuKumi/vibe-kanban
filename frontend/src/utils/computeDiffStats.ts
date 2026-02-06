import type { Diff } from 'shared/types';

export function computeAggregateDiffStats(diffs: Diff[]): {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
} {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const d of diffs) {
    linesAdded += d.additions ?? 0;
    linesRemoved += d.deletions ?? 0;
  }
  return { filesChanged: diffs.length, linesAdded, linesRemoved };
}
