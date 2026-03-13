import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr';
import RawLogText from '@/components/common/RawLogText';
import type { PatchType } from 'shared/types';

export type LogEntry = Extract<
  PatchType,
  { type: 'STDOUT' } | { type: 'STDERR' }
>;

export interface VirtualizedProcessLogsProps {
  logs: LogEntry[];
  error: string | null;
  searchQuery: string;
  matchIndices: number[];
  currentMatchIndex: number;
}

type LogEntryWithKey = LogEntry & { key: string; originalIndex: number };

interface SearchContext {
  searchQuery: string;
  matchIndices: number[];
  currentMatchIndex: number;
}

export function VirtualizedProcessLogs({
  logs,
  error,
  searchQuery,
  matchIndices,
  currentMatchIndex,
}: VirtualizedProcessLogsProps) {
  const { t } = useTranslation('tasks');
  const [items, setItems] = useState<LogEntryWithKey[]>([]);
  const [shouldFollowOutput, setShouldFollowOutput] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const prevLogsLengthRef = useRef(0);
  const prevCurrentMatchRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const logsWithKeys: LogEntryWithKey[] = logs.map((entry, index) => ({
        ...entry,
        key: `log-${index}`,
        originalIndex: index,
      }));

      const isNewData = logs.length > prevLogsLengthRef.current;
      setShouldFollowOutput(isNewData || prevLogsLengthRef.current === 0);

      prevLogsLengthRef.current = logs.length;
      setItems(logsWithKeys);
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [logs]);

  useEffect(() => {
    if (
      matchIndices.length > 0 &&
      currentMatchIndex >= 0 &&
      currentMatchIndex !== prevCurrentMatchRef.current
    ) {
      const logIndex = matchIndices[currentMatchIndex];
      virtuosoRef.current?.scrollToIndex({
        index: logIndex,
        align: 'center',
        behavior: 'smooth',
      });
      prevCurrentMatchRef.current = currentMatchIndex;
    }
  }, [currentMatchIndex, matchIndices]);

  const context: SearchContext = {
    searchQuery,
    matchIndices,
    currentMatchIndex,
  };

  const itemContent = useCallback(
    (_index: number, data: LogEntryWithKey, ctx: SearchContext) => {
      const isMatch = ctx.matchIndices.includes(data.originalIndex);
      const isCurrentMatch =
        ctx.matchIndices[ctx.currentMatchIndex] === data.originalIndex;

      return (
        <RawLogText
          content={data.content}
          channel={data.type === 'STDERR' ? 'stderr' : 'stdout'}
          className="text-sm px-4 py-1"
          linkifyUrls
          searchQuery={isMatch ? ctx.searchQuery : undefined}
          isCurrentMatch={isCurrentMatch}
        />
      );
    },
    []
  );

  const computeItemKey = useCallback(
    (_index: number, data: LogEntryWithKey) => data.key,
    []
  );

  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      if (shouldFollowOutput && isAtBottom) return 'smooth';
      return false;
    },
    [shouldFollowOutput]
  );

  if (logs.length === 0 && !error) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-center text-muted-foreground text-sm">
          {t('processes.noLogsAvailable')}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-center text-destructive text-sm">
          <WarningCircleIcon className="size-icon-base inline mr-2" />
          {error}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full">
      <Virtuoso<LogEntryWithKey, SearchContext>
        ref={virtuosoRef}
        className="h-full"
        data={items}
        context={context}
        computeItemKey={computeItemKey}
        itemContent={itemContent}
        followOutput={followOutput}
        initialTopMostItemIndex={items.length > 0 ? items.length - 1 : 0}
      />
    </div>
  );
}
