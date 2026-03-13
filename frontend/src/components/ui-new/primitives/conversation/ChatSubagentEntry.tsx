import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDownIcon,
  RobotIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { ToolStatus, ToolResult } from 'shared/types';
import { ChatMarkdown } from './ChatMarkdown';

interface ChatSubagentEntryProps {
  description: string;
  subagentType?: string | null;
  result?: ToolResult | null;
  expanded?: boolean;
  onToggle?: () => void;
  className?: string;
  status?: ToolStatus;
  workspaceId?: string;
}

export function ChatSubagentEntry({
  description,
  subagentType,
  result,
  expanded = false,
  onToggle,
  className,
  status,
  workspaceId,
}: ChatSubagentEntryProps) {
  const { t } = useTranslation('common');

  const StatusIcon = useMemo(() => {
    if (!status) return null;
    const statusType = status.status;

    const isSuccess = statusType === 'success';
    const isError =
      statusType === 'failed' ||
      statusType === 'denied' ||
      statusType === 'timed_out';
    const isPending =
      statusType === 'created' || statusType === 'pending_approval';

    if (isSuccess) {
      return (
        <CheckCircleIcon className="size-icon-xs text-success" weight="fill" />
      );
    }
    if (isError) {
      return <XCircleIcon className="size-icon-xs text-error" weight="fill" />;
    }
    if (isPending) {
      return <CircleNotchIcon className="size-icon-xs text-low animate-spin" />;
    }
    return null;
  }, [status]);

  const isErrorStatus = useMemo(() => {
    if (!status) return false;
    return (
      status.status === 'failed' ||
      status.status === 'denied' ||
      status.status === 'timed_out'
    );
  }, [status]);

  const formattedType = useMemo(() => {
    if (!subagentType) return t('conversation.subagent.defaultType');
    return subagentType.charAt(0).toUpperCase() + subagentType.slice(1);
  }, [subagentType, t]);

  const resultContent = useMemo(() => {
    if (!result?.value) return null;

    if (typeof result.value === 'string') {
      return result.value;
    }

    return JSON.stringify(result.value, null, 2);
  }, [result]);

  const hasResult = Boolean(resultContent);

  return (
    <div
      className={cn(
        'rounded-sm border overflow-hidden',
        isErrorStatus && 'border-error bg-error/5',
        status?.status === 'success' && 'border-success/50',
        !isErrorStatus && status?.status !== 'success' && 'border-border',
        className
      )}
    >
      <div
        className={cn(
          'flex items-center px-double py-base gap-base',
          isErrorStatus && 'bg-error/10',
          status?.status === 'success' && 'bg-success/5'
        )}
      >
        <span className="relative shrink-0">
          <RobotIcon className="size-icon-base text-low" />
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-base">
          <span className="text-xs font-medium text-low uppercase tracking-wide">
            {formattedType}
          </span>
          {StatusIcon}
        </div>
      </div>

      <div className="border-t px-double py-base">
        <div className="text-xs font-medium text-low mb-half uppercase tracking-wide">
          {t('conversation.subagent.task', 'Task')}
        </div>
        <div className="text-sm text-normal whitespace-pre-wrap">
          {description}
        </div>
      </div>

      {hasResult && (
        <div className="border-t px-double py-base bg-panel/50">
          <div
            className={cn(
              'flex items-center gap-half mb-half',
              onToggle && 'cursor-pointer'
            )}
            onClick={onToggle}
          >
            <span className="text-xs font-medium text-low uppercase tracking-wide">
              {t('conversation.output')}
            </span>
            {onToggle && (
              <CaretDownIcon
                className={cn(
                  'size-icon-xs shrink-0 text-low transition-transform',
                  !expanded && '-rotate-90'
                )}
              />
            )}
          </div>
          {expanded && (
            <div className="prose prose-sm dark:prose-invert max-w-none mt-half">
              <ChatMarkdown
                content={resultContent!}
                workspaceId={workspaceId}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
