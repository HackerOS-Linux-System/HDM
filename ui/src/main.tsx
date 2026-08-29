import './fonts.css';
import './app.css';
import { render } from 'solid-js/web';
import App from './App';

const root = document.getElementById('app');

if (!root) {
  throw new Error('Root element #app not found');
}

render(() => <App />, root);
