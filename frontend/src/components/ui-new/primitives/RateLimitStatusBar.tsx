import { useState, useEffect } from 'react';
import { ClockIcon, WarningIcon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useRateLimitInfo } from '@/contexts/EntriesContext';

function formatTimeRemaining(resetsAt: number): string {
  const now = Date.now();
  const remainingMs = resetsAt * 1000 - now;

  if (remainingMs <= 0) return 'Resetting...';

  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function RateLimitStatusBar() {
  const rateLimitInfo = useRateLimitInfo();
  const [timeDisplay, setTimeDisplay] = useState('');

  useEffect(() => {
    if (!rateLimitInfo?.resets_at) {
      setTimeDisplay('');
      return;
    }

    const update = () => setTimeDisplay(formatTimeRemaining(Number(rateLimitInfo.resets_at!)));
    update();

    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [rateLimitInfo?.resets_at]);

  if (!rateLimitInfo) return null;

  const isWarning = rateLimitInfo.status === 'allowed_warning';
  const isRejected = rateLimitInfo.status === 'rejected';
  const showIndicator = isWarning || isRejected;

  if (!showIndicator && !rateLimitInfo.resets_at) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-half text-xs px-half py-0.5 rounded',
        isRejected && 'text-error bg-error/10',
        isWarning && 'text-warning bg-warning/10',
        !isWarning && !isRejected && 'text-low'
      )}
      title={
        isRejected
          ? 'Rate limited — usage will resume after reset'
          : isWarning
            ? 'Approaching rate limit'
            : 'Next rate limit reset'
      }
    >
      {isRejected || isWarning ? (
        <WarningIcon className="size-icon-xs shrink-0" />
      ) : (
        <ClockIcon className="size-icon-xs shrink-0" />
      )}
      {timeDisplay && <span>{timeDisplay}</span>}
    </div>
  );
}
