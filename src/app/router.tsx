import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate, type LazyRouteFunction, type RouteObject } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProjectLayout } from '@/features/project-qa/ProjectLayout';
import { InitialLoading } from './InitialLoading';
import { NotFoundPage } from './NotFoundPage';

/**
 * 화면 단위로 코드를 나눈다. 라우트의 lazy를 쓰면 새 화면이 준비될 때까지 이전 화면이 그대로 남아
 * 전환 중에 빈 화면이나 레이아웃 점프가 생기지 않는다. 공통 셸(AppShell, ProjectLayout)은 처음부터 함께 싣는다.
 */
function page<Module, Key extends keyof Module>(load: () => Promise<Module>, name: Key): LazyRouteFunction<RouteObject> {
  return async () => ({ Component: (await load())[name] as ComponentType });
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    hydrateFallbackElement: <InitialLoading />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: 'today', lazy: page(() => import('@/features/today/TodayPage'), 'TodayPage') },
      { path: 'work', lazy: page(() => import('@/features/tasks/WorkPage'), 'WorkPage') },
      { path: 'projects', lazy: page(() => import('@/features/projects/ProjectsPage'), 'ProjectsPage') },
      {
        path: 'projects/:projectId',
        element: <ProjectLayout />,
        children: [
          { index: true, lazy: page(() => import('@/features/project-qa/deliverables/DeliverablesTab'), 'DeliverablesTab') },
          { path: 'requirements', lazy: page(() => import('@/features/project-qa/requirements/RequirementsTab'), 'RequirementsTab') },
          { path: 'test-design', lazy: page(() => import('@/features/project-qa/test-design/TestDesignTab'), 'TestDesignTab') },
          { path: 'results', lazy: page(() => import('@/features/project-qa/results/ResultDashboardTab'), 'ResultDashboardTab') },
          { path: 'issues', lazy: page(() => import('@/features/project-qa/issues/IssuesTab'), 'IssuesTab') },
          { path: 'import-history', lazy: page(() => import('@/features/project-qa/import-history/ImportHistoryTab'), 'ImportHistoryTab') },
          { path: 'records', lazy: page(() => import('@/features/project-qa/records/ProjectRecordsTab'), 'ProjectRecordsTab') },
        ],
      },
      { path: 'records', lazy: page(() => import('@/features/records/RecordsPage'), 'RecordsPage') },
      { path: 'knowledge', lazy: page(() => import('@/features/knowledge/KnowledgePage'), 'KnowledgePage') },
      { path: 'knowledge/:termId', lazy: page(() => import('@/features/knowledge/KnowledgePage'), 'KnowledgePage') },
      { path: 'scratch', lazy: page(() => import('@/features/scratch/ScratchPage'), 'ScratchPage') },
      { path: 'settings', lazy: page(() => import('@/features/settings/SettingsPage'), 'SettingsPage') },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
