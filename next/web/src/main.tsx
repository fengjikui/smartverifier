import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './inspection-density.css';
import './inspection-report.css';
import './inspection-detail.css';
import './inspection-workflow.css';
import './standalone.css';
const root = createRoot(document.getElementById('root')!);
if (location.pathname === '/admin' || location.pathname.startsWith('/admin/')) {
  void import('./admin/index').then(({Admin})=>root.render(<Admin/>));
} else if (location.pathname === '/debug/model' || location.pathname === '/debug/model/') {
  void import('./model-debug').then(({ModelDebug})=>root.render(<ModelDebug/>));
} else if (location.pathname === '/tablet-preview' || location.pathname === '/tablet-preview/') {
  void import('./tablet-simulator').then(({TabletSimulator}) => root.render(<TabletSimulator/>));
} else root.render(<App/>);
