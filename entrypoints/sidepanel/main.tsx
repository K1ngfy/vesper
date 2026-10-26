// Side Panel 形态（文档 4.3）：复用同一工作台组件
import React from 'react';
import ReactDOM from 'react-dom/client';
import WorkbenchApp from '@/src/ui/WorkbenchApp';
import '@/src/ui/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkbenchApp />
  </React.StrictMode>,
);
