import { Link } from 'react-router-dom';
import { LayoutIcon } from '@phosphor-icons/react';
import { useProjects } from '@/hooks/useProjects';
import { paths } from '@/lib/paths';

interface ProjectBreadcrumbProps {
  projectId: string;
}

export function ProjectBreadcrumb({ projectId }: ProjectBreadcrumbProps) {
  const { projectsById } = useProjects();
  const project = projectsById[projectId];

  return (
    <Link
      to={paths.projectTasks(projectId)}
      className="flex items-center gap-half px-half text-sm text-low hover:text-normal hover:bg-secondary rounded-sm transition-colors"
    >
      <LayoutIcon className="size-icon-xs" weight="bold" />
      {project && (
        <span className="truncate max-w-[120px]">{project.name}</span>
      )}
    </Link>
  );
}
