import {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  ReactNode,
} from 'react';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory';
import { TokenUsageInfo, RateLimitInfo } from 'shared/types';

interface EntriesContextType {
  entries: PatchTypeWithKey[];
  setEntries: (entries: PatchTypeWithKey[]) => void;
  setTokenUsageInfo: (info: TokenUsageInfo | null) => void;
  setRateLimitInfo: (info: RateLimitInfo | null) => void;
  reset: () => void;
  tokenUsageInfo: TokenUsageInfo | null;
  rateLimitInfo: RateLimitInfo | null;
}

const EntriesContext = createContext<EntriesContextType | null>(null);

interface EntriesProviderProps {
  children: ReactNode;
}

export const EntriesProvider = ({ children }: EntriesProviderProps) => {
  const [entries, setEntriesState] = useState<PatchTypeWithKey[]>([]);
  const [tokenUsageInfo, setTokenUsageInfo] = useState<TokenUsageInfo | null>(
    null
  );
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo | null>(
    null
  );

  const setEntries = useCallback((newEntries: PatchTypeWithKey[]) => {
    setEntriesState(newEntries);
  }, []);

  const setTokenUsageInfoCallback = useCallback(
    (info: TokenUsageInfo | null) => {
      setTokenUsageInfo(info);
    },
    []
  );

  const setRateLimitInfoCallback = useCallback(
    (info: RateLimitInfo | null) => {
      setRateLimitInfo(info);
    },
    []
  );

  const reset = useCallback(() => {
    setEntriesState([]);
    setTokenUsageInfo(null);
    setRateLimitInfo(null);
  }, []);

  const value = useMemo(
    () => ({
      entries,
      setEntries,
      setTokenUsageInfo: setTokenUsageInfoCallback,
      setRateLimitInfo: setRateLimitInfoCallback,
      reset,
      tokenUsageInfo,
      rateLimitInfo,
    }),
    [
      entries,
      setEntries,
      setTokenUsageInfoCallback,
      setRateLimitInfoCallback,
      reset,
      tokenUsageInfo,
      rateLimitInfo,
    ]
  );

  return (
    <EntriesContext.Provider value={value}>{children}</EntriesContext.Provider>
  );
};

export const useEntries = (): EntriesContextType => {
  const context = useContext(EntriesContext);
  if (!context) {
    throw new Error('useEntries must be used within an EntriesProvider');
  }
  return context;
};

export const useTokenUsage = () => {
  const context = useContext(EntriesContext);
  if (!context) {
    throw new Error('useTokenUsage must be used within an EntriesProvider');
  }
  return context.tokenUsageInfo;
};

export const useRateLimitInfo = () => {
  const context = useContext(EntriesContext);
  if (!context) {
    throw new Error('useRateLimitInfo must be used within an EntriesProvider');
  }
  return context.rateLimitInfo;
};
