import { generateDiffFile } from '@git-diff-view/file';
import type { Diff } from 'shared/types';

function computeDiffStatsFromContent(
  oldContent: string,
  newContent: string,
  oldPath: string,
  newPath: string
): { additions: number; deletions: number } {
  if (oldContent === newContent) return { additions: 0, deletions: 0 };
  try {
    const file = generateDiffFile(
      oldPath,
      oldContent,
      newPath,
      newContent,
      'plaintext',
      'plaintext'
    );
    file.initRaw();
    return {
      additions: file.additionLength ?? 0,
      deletions: file.deletionLength ?? 0,
    };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

export function computeDiffEntryStats(d: Diff): {
  additions: number;
  deletions: number;
} {
  if (!d.contentOmitted && (d.oldContent != null || d.newContent != null)) {
    return computeDiffStatsFromContent(
      d.oldContent ?? '',
      d.newContent ?? '',
      d.oldPath ?? d.newPath ?? 'unknown',
      d.newPath ?? d.oldPath ?? 'unknown'
    );
  }
  return { additions: d.additions ?? 0, deletions: d.deletions ?? 0 };
}

export function computeAggregateDiffStats(diffs: Diff[]): {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
} {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const d of diffs) {
    const stats = computeDiffEntryStats(d);
    linesAdded += stats.additions;
    linesRemoved += stats.deletions;
  }
  return { filesChanged: diffs.length, linesAdded, linesRemoved };
}
