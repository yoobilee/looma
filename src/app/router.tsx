import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { TodayPage } from '@/features/today/TodayPage';
import { WorkPage } from '@/features/tasks/WorkPage';
import { ProjectsPage } from '@/features/projects/ProjectsPage';
import { ProjectLayout } from '@/features/project-qa/ProjectLayout';
import { DeliverablesTab } from '@/features/project-qa/deliverables/DeliverablesTab';
import { RequirementsTab } from '@/features/project-qa/requirements/RequirementsTab';
import { TestDesignTab } from '@/features/project-qa/test-design/TestDesignTab';
import { ResultDashboardTab } from '@/features/project-qa/results/ResultDashboardTab';
import { IssuesTab } from '@/features/project-qa/issues/IssuesTab';
import { ProjectRecordsTab } from '@/features/project-qa/records/ProjectRecordsTab';
import { RecordsPage } from '@/features/records/RecordsPage';
import { KnowledgePage } from '@/features/knowledge/KnowledgePage';
import { ScratchPage } from '@/features/scratch/ScratchPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { NotFoundPage } from './NotFoundPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: 'today', element: <TodayPage /> },
      { path: 'work', element: <WorkPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      {
        path: 'projects/:projectId',
        element: <ProjectLayout />,
        children: [
          { index: true, element: <DeliverablesTab /> },
          { path: 'requirements', element: <RequirementsTab /> },
          { path: 'test-design', element: <TestDesignTab /> },
          { path: 'results', element: <ResultDashboardTab /> },
          { path: 'issues', element: <IssuesTab /> },
          { path: 'records', element: <ProjectRecordsTab /> },
        ],
      },
      { path: 'records', element: <RecordsPage /> },
      { path: 'knowledge', element: <KnowledgePage /> },
      { path: 'knowledge/:termId', element: <KnowledgePage /> },
      { path: 'scratch', element: <ScratchPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
