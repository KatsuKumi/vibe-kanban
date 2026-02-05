import { Link } from 'react-router-dom';
import { useShape } from '@/lib/electric/hooks';
import { PROJECT_ISSUES_SHAPE } from 'shared/remote-types';
import { LayoutIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useOrganizationStore } from '@/stores/useOrganizationStore';
import { useOrganizationProjects } from '@/hooks/useOrganizationProjects';

interface ProjectBreadcrumbProps {
  projectId: string;
  issueId: string | null;
}

export function ProjectBreadcrumb({
  projectId,
  issueId,
}: ProjectBreadcrumbProps) {
  const selectedOrgId = useOrganizationStore((s) => s.selectedOrgId);
  const { data: projects } = useOrganizationProjects(selectedOrgId);
  const project = projects.find((p) => p.id === projectId);

  const { data: issues, isLoading: issuesLoading } = useShape(
    PROJECT_ISSUES_SHAPE,
    { project_id: projectId },
    { enabled: !!issueId }
  );

  const issue = issueId ? issues.find((i) => i.id === issueId) : null;

  if (!project) return null;

  return (
    <div className="flex items-center gap-half text-sm text-low">
      <Link
        to={`/projects/${projectId}`}
        className="flex items-center gap-half px-half hover:text-normal hover:bg-secondary rounded-sm transition-colors"
      >
        <LayoutIcon className="size-icon-xs" weight="bold" />
        <span className="truncate max-w-[120px]">{project.name}</span>
      </Link>
      {issueId && !issuesLoading && issue && (
        <>
          <CaretRightIcon className="size-icon-xs shrink-0" />
          <Link
            to={`/projects/${projectId}/issues/${issueId}`}
            className="flex items-center px-half hover:text-normal hover:bg-secondary rounded-sm transition-colors"
          >
            <span>{issue.simple_id}</span>
          </Link>
        </>
      )}
    </div>
  );
}
