import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MARKING_BASE, markingPaths } from '../../shared/paths';
import './style.css';
import './inspection-density.css';
import './inspection-report.css';
import './inspection-detail.css';
import './inspection-workflow.css';
import './standalone.css';
const root = createRoot(document.getElementById('root')!);
if (location.pathname.startsWith(MARKING_BASE + '/admin/')) {
  void import('./admin/index').then(({Admin})=>root.render(<Admin/>));
} else if (location.pathname === markingPaths.debug) {
  void import('./model-debug').then(({ModelDebug})=>root.render(<ModelDebug/>));
} else if (location.pathname === markingPaths.preview) {
  void import('./tablet-simulator').then(({TabletSimulator}) => root.render(<TabletSimulator/>));
} else if (location.pathname === markingPaths.loginPreview) {
  void import('./login-preview').then(({LoginPreview})=>root.render(<LoginPreview/>));
} else root.render(<App/>);
