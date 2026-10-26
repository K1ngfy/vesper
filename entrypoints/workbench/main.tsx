import React from 'react';
import ReactDOM from 'react-dom/client';
import WorkbenchApp from '@/src/ui/WorkbenchApp';
import '@/src/ui/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkbenchApp />
  </React.StrictMode>,
);
