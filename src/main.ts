import './styles.css';
import { App } from './app';
import { APP } from './config';
import { browserStorage } from './store/layout';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');

document.title = APP.name;
const app = new App(root, browserStorage());
app.start().catch((error: unknown) => {
  console.error(error);
  root.textContent = `${APP.name} failed to start: ${error instanceof Error ? error.message : String(error)}`;
});
