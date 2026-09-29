import { useOutletContext } from 'react-router-dom';
import type { Project } from '@/domain/types';

export interface ProjectOutletContext {
  project: Project;
  openDeliverableCreate: () => void;
}

export function useProjectContext(): ProjectOutletContext {
  return useOutletContext<ProjectOutletContext>();
}
