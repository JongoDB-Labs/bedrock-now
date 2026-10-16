// Entry point: render the shell and start talking to the backend.
import { render } from 'preact';
import { AppShell } from './components/Shell';
import { boot } from './app';
import './styles/app.css';

const root = document.createElement('div');
root.id = 'app';
document.body.append(root);
render(<AppShell />, root);
void boot();
