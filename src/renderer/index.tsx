/* @refresh reload */
import { render } from 'solid-js/web';
import App from './App';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './styles/index.css';

const root = document.getElementById('root');
if (root) {
    render(() => <App />, root);
}
