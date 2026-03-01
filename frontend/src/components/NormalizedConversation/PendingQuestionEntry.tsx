import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApprovalStatus, JsonValue, ToolStatus } from 'shared/types';
import { Button } from '@/components/ui/button';
import { approvalsApi } from '@/lib/api';
import { MessageCircleQuestion, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface PendingQuestionEntryProps {
  pendingStatus: Extract<ToolStatus, { status: 'pending_approval' }>;
  executionProcessId?: string;
  children: ReactNode;
}

function parseQuestions(toolInput: JsonValue | undefined): Question[] {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput))
    return [];
  const input = toolInput as Record<string, unknown>;
  const questions = input.questions;
  if (!Array.isArray(questions)) return [];
  return questions as Question[];
}

function QuestionCard({
  question,
  selectedOptions,
  customText,
  isCustomMode,
  disabled,
  onToggleOption,
  onSetCustomMode,
  onCustomTextChange,
}: {
  question: Question;
  selectedOptions: Set<string>;
  customText: string;
  isCustomMode: boolean;
  disabled: boolean;
  onToggleOption: (label: string) => void;
  onSetCustomMode: (active: boolean) => void;
  onCustomTextChange: (text: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium bg-muted px-2 py-0.5 rounded">
          {question.header}
        </span>
        <span className="text-sm font-medium">{question.question}</span>
      </div>
      {question.multiSelect && (
        <span className="text-xs text-muted-foreground">
          Select one or more options
        </span>
      )}
      <div className="flex flex-col gap-1.5">
        {question.options.map((opt) => {
          const isSelected = selectedOptions.has(opt.label);
          return (
            <button
              key={opt.label}
              onClick={() => onToggleOption(opt.label)}
              disabled={disabled || isCustomMode}
              className={cn(
                'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isSelected &&
                  !isCustomMode &&
                  'border-primary bg-primary/10 ring-1 ring-primary/30',
                disabled && 'opacity-50 cursor-not-allowed',
                isCustomMode && 'opacity-40'
              )}
            >
              <div
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                  isSelected && !isCustomMode
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/40'
                )}
              >
                {isSelected && !isCustomMode && (
                  <Check className="h-3 w-3" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{opt.label}</div>
                {opt.description && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {opt.description}
                  </div>
                )}
              </div>
            </button>
          );
        })}

        <button
          onClick={() => onSetCustomMode(!isCustomMode)}
          disabled={disabled}
          className={cn(
            'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors',
            'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            isCustomMode &&
              'border-primary bg-primary/10 ring-1 ring-primary/30',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        >
          <div
            className={cn(
              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
              isCustomMode
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-muted-foreground/40'
            )}
          >
            {isCustomMode && <Check className="h-3 w-3" />}
          </div>
          <div className="font-medium">Other</div>
        </button>

        {isCustomMode && (
          <input
            type="text"
            value={customText}
            onChange={(e) => onCustomTextChange(e.target.value)}
            disabled={disabled}
            placeholder="Type your answer..."
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            autoFocus
          />
        )}
      </div>
    </div>
  );
}

const PendingQuestionEntry = ({
  pendingStatus,
  executionProcessId,
  children,
}: PendingQuestionEntryProps) => {
  const questions = parseQuestions(pendingStatus.tool_input);
  const [isResponding, setIsResponding] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selections, setSelections] = useState<
    Map<string, { selected: Set<string>; customText: string; isCustom: boolean }>
  >(() => {
    const map = new Map<
      string,
      { selected: Set<string>; customText: string; isCustom: boolean }
    >();
    for (const q of questions) {
      map.set(q.question, {
        selected: new Set(),
        customText: '',
        isCustom: false,
      });
    }
    return map;
  });

  const disabled = isResponding || hasResponded;

  const toggleOption = useCallback(
    (questionKey: string, label: string, multiSelect: boolean) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const state = next.get(questionKey);
        if (!state) return prev;
        const newSelected = new Set(state.selected);
        if (multiSelect) {
          if (newSelected.has(label)) newSelected.delete(label);
          else newSelected.add(label);
        } else {
          newSelected.clear();
          newSelected.add(label);
        }
        next.set(questionKey, {
          ...state,
          selected: newSelected,
          isCustom: false,
        });
        return next;
      });
    },
    []
  );

  const setCustomMode = useCallback(
    (questionKey: string, active: boolean) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const state = next.get(questionKey);
        if (!state) return prev;
        next.set(questionKey, {
          ...state,
          isCustom: active,
          selected: active ? new Set() : state.selected,
        });
        return next;
      });
    },
    []
  );

  const setCustomText = useCallback(
    (questionKey: string, text: string) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const state = next.get(questionKey);
        if (!state) return prev;
        next.set(questionKey, { ...state, customText: text });
        return next;
      });
    },
    []
  );

  const canSubmit = questions.every((q) => {
    const state = selections.get(q.question);
    if (!state) return false;
    if (state.isCustom) return state.customText.trim().length > 0;
    return state.selected.size > 0;
  });

  const handleSubmit = useCallback(async () => {
    if (disabled || !canSubmit || !executionProcessId) return;

    setIsResponding(true);
    setError(null);

    const answers: Record<string, string> = {};
    for (const q of questions) {
      const state = selections.get(q.question);
      if (!state) continue;
      if (state.isCustom) {
        answers[q.question] = state.customText.trim();
      } else {
        answers[q.question] = Array.from(state.selected).join(', ');
      }
    }

    const status: ApprovalStatus = {
      status: 'answered',
      answers: answers as unknown as JsonValue,
    };

    try {
      await approvalsApi.respond(pendingStatus.approval_id, {
        execution_process_id: executionProcessId,
        status,
      });
      setHasResponded(true);
    } catch (e: unknown) {
      console.error('Question response failed:', e);
      setError(e instanceof Error ? e.message : 'Failed to send response');
    } finally {
      setIsResponding(false);
    }
  }, [
    disabled,
    canSubmit,
    executionProcessId,
    questions,
    selections,
    pendingStatus.approval_id,
  ]);

  const handleSkip = useCallback(async () => {
    if (disabled || !executionProcessId) return;

    setIsResponding(true);
    setError(null);

    const status: ApprovalStatus = {
      status: 'denied',
      reason: 'User skipped the question',
    };

    try {
      await approvalsApi.respond(pendingStatus.approval_id, {
        execution_process_id: executionProcessId,
        status,
      });
      setHasResponded(true);
    } catch (e: unknown) {
      console.error('Question skip failed:', e);
      setError(e instanceof Error ? e.message : 'Failed to send response');
    } finally {
      setIsResponding(false);
    }
  }, [disabled, executionProcessId, pendingStatus.approval_id]);

  if (questions.length === 0) {
    return <>{children}</>;
  }

  return (
    <div className="relative mt-3">
      <div className="overflow-hidden">
        {children}

        <div className="bg-background border-t px-4 py-3 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <MessageCircleQuestion className="h-4 w-4 text-primary" />
            <span>The agent has a question for you</span>
          </div>

          <div className="space-y-4">
            {questions.map((q) => {
              const state = selections.get(q.question) ?? {
                selected: new Set<string>(),
                customText: '',
                isCustom: false,
              };
              return (
                <QuestionCard
                  key={q.question}
                  question={q}
                  selectedOptions={state.selected}
                  customText={state.customText}
                  isCustomMode={state.isCustom}
                  disabled={disabled}
                  onToggleOption={(label) =>
                    toggleOption(q.question, label, q.multiSelect)
                  }
                  onSetCustomMode={(active) =>
                    setCustomMode(q.question, active)
                  }
                  onCustomTextChange={(text) =>
                    setCustomText(q.question, text)
                  }
                />
              );
            })}
          </div>

          {error && (
            <div className="text-xs text-red-600" role="alert">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSkip}
              disabled={disabled}
            >
              <X className="h-4 w-4 mr-1" />
              Skip
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={disabled || !canSubmit}
            >
              <Check className="h-4 w-4 mr-1" />
              {isResponding ? 'Submitting…' : 'Submit'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PendingQuestionEntry;
