import { ReactNode, useState, useEffect, useMemo } from 'react';
import { useUserSystem } from '@/components/ConfigProvider';
import { PortalContainerContext } from '@/contexts/PortalContainerContext';
import {
  WorkspaceProvider,
  useWorkspaceContext,
} from '@/contexts/WorkspaceContext';
import { ActionsProvider } from '@/contexts/ActionsContext';
import { SequenceTrackerProvider } from '@/keyboard/SequenceTracker';
import { SequenceIndicator } from '@/keyboard/SequenceIndicator';
import { useWorkspaceShortcuts } from '@/keyboard/useWorkspaceShortcuts';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { LogsPanelProvider } from '@/contexts/LogsPanelContext';
import NiceModal from '@ebay/nice-modal-react';
import { useKeyShowHelp, Scope } from '@/keyboard';
import { KeyboardShortcutsDialog } from '@/components/ui-new/dialogs/KeyboardShortcutsDialog';
import '@/styles/new/index.css';

interface NewDesignScopeProps {
  children: ReactNode;
}

// Wrapper component to get workspaceId from context for ExecutionProcessesProvider
function ExecutionProcessesProviderWrapper({
  children,
}: {
  children: ReactNode;
}) {
  const { workspaceId, selectedSessionId } = useWorkspaceContext();
  return (
    <ExecutionProcessesProvider
      attemptId={workspaceId}
      sessionId={selectedSessionId}
    >
      {children}
    </ExecutionProcessesProvider>
  );
}

function KeyboardShortcutsHandler() {
  useKeyShowHelp(
    () => {
      KeyboardShortcutsDialog.show();
    },
    { scope: Scope.GLOBAL }
  );
  useWorkspaceShortcuts();
  return null;
}

const CUSTOM_FONT_LINK_ID = 'vk-custom-font';

export function NewDesignScope({ children }: NewDesignScopeProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const { config } = useUserSystem();
  const fontFamily = config?.font_family ?? null;

  useEffect(() => {
    const existing = document.getElementById(CUSTOM_FONT_LINK_ID);

    if (!fontFamily) {
      existing?.remove();
      return;
    }

    const encoded = encodeURIComponent(fontFamily);
    const href = `https://fonts.googleapis.com/css2?family=${encoded}:wght@400;500;600;700&display=swap`;

    if (existing instanceof HTMLLinkElement) {
      existing.href = href;
    } else {
      const link = document.createElement('link');
      link.id = CUSTOM_FONT_LINK_ID;
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
    }

    return () => {
      document.getElementById(CUSTOM_FONT_LINK_ID)?.remove();
    };
  }, [fontFamily]);

  const fontStyle = useMemo(
    () =>
      fontFamily
        ? { fontFamily: `"${fontFamily}", "Noto Emoji", sans-serif` }
        : undefined,
    [fontFamily]
  );

  return (
    <div ref={setContainer} className="new-design h-full" style={fontStyle}>
      {container && (
        <PortalContainerContext.Provider value={container}>
          <WorkspaceProvider>
            <ExecutionProcessesProviderWrapper>
              <LogsPanelProvider>
                <ActionsProvider>
                  <SequenceTrackerProvider>
                    <SequenceIndicator />
                    <NiceModal.Provider>
                      <KeyboardShortcutsHandler />
                      {children}
                    </NiceModal.Provider>
                  </SequenceTrackerProvider>
                </ActionsProvider>
              </LogsPanelProvider>
            </ExecutionProcessesProviderWrapper>
          </WorkspaceProvider>
        </PortalContainerContext.Provider>
      )}
    </div>
  );
}
