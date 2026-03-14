import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';
import NewDisplayConversationEntry from './NewDisplayConversationEntry';
import { ApprovalFormProvider } from '@/contexts/ApprovalFormContext';
import { useEntries } from '@/contexts/EntriesContext';
import {
  useResetProcess,
  type UseResetProcessResult,
} from '@/components/ui-new/hooks/useResetProcess';
import {
  AddEntryType,
  PatchTypeWithKey,
  DisplayEntry,
  isAggregatedGroup,
  isAggregatedDiffGroup,
  useConversationHistory,
} from '@/components/ui-new/hooks/useConversationHistory';
import { aggregateConsecutiveEntries } from '@/utils/aggregateEntries';
import type { WorkspaceWithSession } from '@/types/attempt';
import type { RepoWithTargetBranch } from 'shared/types';
import { useWorkspaceContext } from '@/contexts/WorkspaceContext';
import { ChatScriptPlaceholder } from '../primitives/conversation/ChatScriptPlaceholder';
import { ScriptFixerDialog } from '@/components/dialogs/scripts/ScriptFixerDialog';

interface ConversationListProps {
  attempt: WorkspaceWithSession;
}

export interface ConversationListHandle {
  scrollToPreviousUserMessage: () => void;
  scrollToBottom: () => void;
}

interface MessageListContext {
  attempt: WorkspaceWithSession;
  onConfigureSetup: (() => void) | undefined;
  onConfigureCleanup: (() => void) | undefined;
  showSetupPlaceholder: boolean;
  showCleanupPlaceholder: boolean;
  resetAction: UseResetProcessResult;
}

const HeaderComponent = ({ context }: { context?: MessageListContext }) => (
  <div className="pt-2">
    {context?.showSetupPlaceholder && (
      <div className="my-base px-double">
        <ChatScriptPlaceholder
          type="setup"
          onConfigure={context.onConfigureSetup}
        />
      </div>
    )}
  </div>
);

const FooterComponent = ({ context }: { context?: MessageListContext }) => (
  <div className="pb-2">
    {context?.showCleanupPlaceholder && (
      <div className="my-base px-double">
        <ChatScriptPlaceholder
          type="cleanup"
          onConfigure={context.onConfigureCleanup}
        />
      </div>
    )}
  </div>
);

export const ConversationList = forwardRef<
  ConversationListHandle,
  ConversationListProps
>(function ConversationList({ attempt }, ref) {
  const resetAction = useResetProcess();
  const [items, setItems] = useState<DisplayEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [shouldFollowOutput, setShouldFollowOutput] = useState(false);
  const [shouldScrollToLastStart, setShouldScrollToLastStart] = useState(false);
  const { setEntries, reset } = useEntries();
  const pendingUpdateRef = useRef<{
    entries: PatchTypeWithKey[];
    addType: AddEntryType;
    loading: boolean;
  } | null>(null);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRangeRef = useRef<{ startIndex: number; endIndex: number }>({
    startIndex: 0,
    endIndex: 0,
  });

  let repos: RepoWithTargetBranch[] = [];
  try {
    const workspaceContext = useWorkspaceContext();
    repos = workspaceContext.repos;
  } catch {
    // Context not available
  }

  const reposRef = useRef(repos);
  reposRef.current = repos;

  const hasSetupScript = repos.some((repo) => repo.setup_script);
  const hasCleanupScript = repos.some((repo) => repo.cleanup_script);

  const handleConfigureSetup = useCallback(() => {
    const currentRepos = reposRef.current;
    if (currentRepos.length === 0) return;

    ScriptFixerDialog.show({
      scriptType: 'setup',
      repos: currentRepos,
      workspaceId: attempt.id,
      sessionId: attempt.session?.id,
    });
  }, [attempt.id, attempt.session?.id]);

  const handleConfigureCleanup = useCallback(() => {
    const currentRepos = reposRef.current;
    if (currentRepos.length === 0) return;

    ScriptFixerDialog.show({
      scriptType: 'cleanup',
      repos: currentRepos,
      workspaceId: attempt.id,
      sessionId: attempt.session?.id,
    });
  }, [attempt.id, attempt.session?.id]);

  const canConfigure = repos.length > 0;

  useEffect(() => {
    setLoading(true);
    setItems([]);
    setShouldFollowOutput(false);
    setShouldScrollToLastStart(false);
    reset();
  }, [attempt.id, reset]);

  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  const onEntriesUpdated = (
    newEntries: PatchTypeWithKey[],
    addType: AddEntryType,
    newLoading: boolean
  ) => {
    pendingUpdateRef.current = {
      entries: newEntries,
      addType,
      loading: newLoading,
    };

    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    debounceTimeoutRef.current = setTimeout(() => {
      const pending = pendingUpdateRef.current;
      if (!pending) return;

      if (pending.addType === 'plan' && !loading) {
        setShouldFollowOutput(false);
        setShouldScrollToLastStart(true);
      } else if (pending.addType === 'running' && !loading) {
        setShouldFollowOutput(true);
        setShouldScrollToLastStart(false);
      } else if (loading && !pending.loading) {
        setShouldFollowOutput(true);
        setShouldScrollToLastStart(false);
      } else {
        setShouldFollowOutput(false);
        setShouldScrollToLastStart(false);
      }

      const aggregatedEntries = aggregateConsecutiveEntries(pending.entries);

      setItems(aggregatedEntries);
      setEntries(pending.entries);

      if (loading) {
        setLoading(pending.loading);
      }
    }, 100);
  };

  const { hasSetupScriptRun, hasCleanupScriptRun, hasRunningProcess } =
    useConversationHistory({ attempt, onEntriesUpdated });

  const hasEntries = items.length > 0;

  const showSetupPlaceholder =
    !hasSetupScript && !hasSetupScriptRun && hasEntries;
  const showCleanupPlaceholder =
    !hasCleanupScript &&
    !hasCleanupScriptRun &&
    !hasRunningProcess &&
    hasEntries;

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const messageListContext = useMemo(
    () => ({
      attempt,
      onConfigureSetup: canConfigure ? handleConfigureSetup : undefined,
      onConfigureCleanup: canConfigure ? handleConfigureCleanup : undefined,
      showSetupPlaceholder,
      showCleanupPlaceholder,
      resetAction,
    }),
    [
      attempt,
      canConfigure,
      handleConfigureSetup,
      handleConfigureCleanup,
      showSetupPlaceholder,
      showCleanupPlaceholder,
      resetAction,
    ]
  );

  const handleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      visibleRangeRef.current = range;
    },
    []
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToPreviousUserMessage: () => {
        if (!items.length || !virtuosoRef.current) return;

        const firstVisibleIndex = visibleRangeRef.current.startIndex;

        const userMessageIndices: number[] = [];
        items.forEach((item, index) => {
          if (
            item.type === 'NORMALIZED_ENTRY' &&
            item.content.entry_type.type === 'user_message'
          ) {
            userMessageIndices.push(index);
          }
        });

        const targetIndex = userMessageIndices
          .reverse()
          .find((idx) => idx < firstVisibleIndex);

        if (targetIndex !== undefined) {
          virtuosoRef.current.scrollToIndex({
            index: targetIndex,
            align: 'start',
            behavior: 'smooth',
          });
        }
      },
      scrollToBottom: () => {
        if (!virtuosoRef.current) return;
        virtuosoRef.current.scrollToIndex({
          index: 'LAST',
          align: 'end',
          behavior: 'smooth',
        });
      },
    }),
    [items]
  );

  useEffect(() => {
    if (shouldScrollToLastStart && items.length > 0 && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({
        index: items.length - 1,
        align: 'start',
        behavior: 'smooth',
      });
      setShouldScrollToLastStart(false);
    }
  }, [shouldScrollToLastStart, items]);

  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    if (!loading && items.length > 0 && !initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: items.length - 1,
          align: 'end',
          behavior: 'auto',
        });
      });
    }
  }, [loading, items.length]);

  useEffect(() => {
    initialScrollDoneRef.current = false;
  }, [attempt.id]);

  const hasContent = !loading || items.length > 0;

  const itemContent = useCallback(
    (_index: number, data: DisplayEntry, context: MessageListContext) => {
      const currentAttempt = context?.attempt;
      const currentResetAction = context?.resetAction;

      if (isAggregatedGroup(data)) {
        return (
          <NewDisplayConversationEntry
            expansionKey={data.patchKey}
            aggregatedGroup={data}
            aggregatedDiffGroup={null}
            entry={null}
            executionProcessId={data.executionProcessId}
            taskAttempt={currentAttempt}
            resetAction={currentResetAction}
          />
        );
      }

      if (isAggregatedDiffGroup(data)) {
        return (
          <NewDisplayConversationEntry
            expansionKey={data.patchKey}
            aggregatedGroup={null}
            aggregatedDiffGroup={data}
            entry={null}
            executionProcessId={data.executionProcessId}
            taskAttempt={currentAttempt}
            resetAction={currentResetAction}
          />
        );
      }

      if (data.type === 'STDOUT') {
        return <p>{data.content}</p>;
      }
      if (data.type === 'STDERR') {
        return <p>{data.content}</p>;
      }
      if (data.type === 'NORMALIZED_ENTRY' && currentAttempt) {
        return (
          <NewDisplayConversationEntry
            expansionKey={data.patchKey}
            entry={data.content}
            aggregatedGroup={null}
            aggregatedDiffGroup={null}
            executionProcessId={data.executionProcessId}
            taskAttempt={currentAttempt}
            resetAction={currentResetAction}
          />
        );
      }

      return null;
    },
    []
  );

  const computeItemKey = useCallback(
    (_index: number, data: DisplayEntry) => `conv-${data.patchKey}`,
    []
  );

  const followOutput = useCallback(
    (_isAtBottom: boolean) => {
      if (shouldFollowOutput) return 'smooth';
      return false;
    },
    [shouldFollowOutput]
  );

  const components = useMemo(
    () => ({
      Header: HeaderComponent,
      Footer: FooterComponent,
    }),
    []
  );

  return (
    <ApprovalFormProvider>
      <div
        className={cn(
          'h-full transition-opacity duration-300',
          hasContent ? 'opacity-100' : 'opacity-0'
        )}
      >
        <Virtuoso<DisplayEntry, MessageListContext>
          ref={virtuosoRef}
          className="h-full scrollbar-none"
          data={items}
          context={messageListContext}
          computeItemKey={computeItemKey}
          itemContent={itemContent}
          followOutput={followOutput}
          initialTopMostItemIndex={items.length > 0 ? items.length - 1 : 0}
          alignToBottom
          rangeChanged={handleRangeChanged}
          components={components}
        />
      </div>
    </ApprovalFormProvider>
  );
});

export default ConversationList;
