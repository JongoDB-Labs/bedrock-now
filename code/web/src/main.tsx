// Entry point: render the shell and start talking to the backend.
import { render } from 'preact';
import { AppShell } from './components/Shell';
import { boot, openFile, openGitDialog, showGit, store } from './app';
import { fsFind } from './api';
import { listenPortal } from './portalbridge';
import './styles/app.css';
import './styles/review.css';
import './styles/polish.css';
import './styles/git.css';
import './styles/mentions.css';
import './styles/projects.css';

const root = document.createElement('div');
root.id = 'app';
document.body.append(root);
render(<AppShell />, root);
void boot();
// the portal's global search may ask this page for its sessions and files, and the portal open a file or the Git panel's
// Git hosts / Clone dialog in place (only the portal that frames it)
listenPortal({ portal: () => store.get().server?.portalOrigin ?? null, sessions: () => store.get().sessions, find: fsFind, openFile,
  openGit: (dialog) => { showGit(); openGitDialog(dialog); } });
