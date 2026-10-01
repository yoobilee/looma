import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles/tokens.css';
import './styles/base.css';
import { PersistenceGate } from './app/PersistenceGate';
import { ThemeProvider } from './app/ThemeProvider';
import { router } from './app/router';

const root = document.getElementById('root');
if (!root) throw new Error('#root 요소가 없어요.');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <PersistenceGate>
        <RouterProvider router={router} />
      </PersistenceGate>
    </ThemeProvider>
  </StrictMode>,
);
