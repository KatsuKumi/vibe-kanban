import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import DisplayConversationEntry from '../NormalizedConversation/DisplayConversationEntry';
import { useEntries } from '@/contexts/EntriesContext';
import {
  AddEntryType,
  PatchTypeWithKey,
  useConversationHistory,
} from '@/hooks/useConversationHistory';
import { Loader2 } from 'lucide-react';
import { TaskWithAttemptStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { ApprovalFormProvider } from '@/contexts/ApprovalFormContext';

interface VirtualizedListProps {
  attempt: WorkspaceWithSession;
  task?: TaskWithAttemptStatus;
}

interface MessageListContext {
  attempt: WorkspaceWithSession;
  task?: TaskWithAttemptStatus;
}

const VirtualizedList = ({ attempt, task }: VirtualizedListProps) => {
  const [items, setItems] = useState<PatchTypeWithKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [shouldFollowOutput, setShouldFollowOutput] = useState(false);
  const { setEntries, reset } = useEntries();
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    setLoading(true);
    setItems([]);
    setShouldFollowOutput(false);
    reset();
  }, [attempt.id, reset]);

  const onEntriesUpdated = useCallback(
    (
      newEntries: PatchTypeWithKey[],
      addType: AddEntryType,
      newLoading: boolean
    ) => {
      const isStreamingUpdate =
        (addType === 'running' || addType === 'plan') && !loading;
      setShouldFollowOutput(isStreamingUpdate);

      setItems(newEntries);
      setEntries(newEntries);

      if (loading) {
        setLoading(newLoading);
      }
    },
    [loading, setEntries]
  );

  useConversationHistory({ attempt, onEntriesUpdated });

  const messageListContext = useMemo<MessageListContext>(
    () => ({ attempt, task }),
    [attempt, task]
  );

  const itemContent = useCallback(
    (_index: number, data: PatchTypeWithKey, context: MessageListContext) => {
      if (data.type === 'STDOUT') {
        return <p>{data.content}</p>;
      }
      if (data.type === 'STDERR') {
        return <p>{data.content}</p>;
      }
      if (data.type === 'NORMALIZED_ENTRY' && context.attempt) {
        return (
          <DisplayConversationEntry
            expansionKey={data.patchKey}
            entry={data.content}
            executionProcessId={data.executionProcessId}
            taskAttempt={context.attempt}
            task={context.task}
          />
        );
      }

      return null;
    },
    []
  );

  const computeItemKey = useCallback(
    (_index: number, data: PatchTypeWithKey) => `l-${data.patchKey}`,
    []
  );

  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      if (shouldFollowOutput && isAtBottom) return 'smooth';
      return false;
    },
    [shouldFollowOutput]
  );

  return (
    <ApprovalFormProvider>
      <Virtuoso<PatchTypeWithKey, MessageListContext>
        ref={virtuosoRef}
        className="flex-1"
        data={items}
        context={messageListContext}
        computeItemKey={computeItemKey}
        itemContent={itemContent}
        followOutput={followOutput}
        initialTopMostItemIndex={items.length > 0 ? items.length - 1 : 0}
        alignToBottom
        components={{
          Header: () => <div className="h-2"></div>,
          Footer: () => <div className="h-2"></div>,
        }}
      />
      {loading && (
        <div className="float-left top-0 left-0 w-full h-full bg-primary flex flex-col gap-2 justify-center items-center">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p>Loading History</p>
        </div>
      )}
    </ApprovalFormProvider>
  );
};

export default VirtualizedList;
