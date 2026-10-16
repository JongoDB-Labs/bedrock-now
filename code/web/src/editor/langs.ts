// Language support by file name, each loaded on first use (separate chunks).
import type { Extension } from '@codemirror/state';
import { StreamLanguage, type StreamParser } from '@codemirror/language';

function ext(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  if (/^\.(bash|zsh)rc$|^\.profile$|^\.env(\..*)?$/.test(lower)) return lower.startsWith('.env') ? 'env' : 'sh';
  const i = lower.lastIndexOf('.');
  return i > 0 ? lower.slice(i + 1) : '';
}

const legacy = async (load: () => Promise<StreamParser<unknown>>): Promise<Extension> => StreamLanguage.define(await load());

export async function languageFor(path: string): Promise<Extension | null> {
  try {
    switch (ext(path)) {
      case 'ts':
      case 'mts':
      case 'cts':
        return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
      case 'tsx':
        return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
      case 'js':
      case 'mjs':
      case 'cjs':
        return (await import('@codemirror/lang-javascript')).javascript();
      case 'jsx':
        return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
      case 'py':
      case 'pyi':
        return (await import('@codemirror/lang-python')).python();
      case 'json':
      case 'jsonc':
      case 'json5':
        return (await import('@codemirror/lang-json')).json();
      case 'md':
      case 'markdown':
      case 'mdx':
        return (await import('@codemirror/lang-markdown')).markdown();
      case 'html':
      case 'htm':
        return (await import('@codemirror/lang-html')).html();
      case 'css':
      case 'scss':
      case 'less':
        return (await import('@codemirror/lang-css')).css();
      case 'yml':
      case 'yaml':
        return (await import('@codemirror/lang-yaml')).yaml();
      case 'rs':
        return (await import('@codemirror/lang-rust')).rust();
      case 'go':
        return (await import('@codemirror/lang-go')).go();
      case 'java':
      case 'kt':
        return (await import('@codemirror/lang-java')).java();
      case 'c':
      case 'h':
      case 'cc':
      case 'cpp':
      case 'cxx':
      case 'hpp':
      case 'hh':
        return (await import('@codemirror/lang-cpp')).cpp();
      case 'sql':
        return (await import('@codemirror/lang-sql')).sql();
      case 'xml':
      case 'svg':
      case 'plist':
      case 'xsd':
        return (await import('@codemirror/lang-xml')).xml();
      case 'php':
        return (await import('@codemirror/lang-php')).php();
      case 'sh':
      case 'bash':
      case 'zsh':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell as StreamParser<unknown>);
      case 'toml':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml as StreamParser<unknown>);
      case 'dockerfile':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile as StreamParser<unknown>);
      case 'rb':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby as StreamParser<unknown>);
      case 'lua':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/lua')).lua as StreamParser<unknown>);
      case 'ini':
      case 'cfg':
      case 'conf':
      case 'properties':
      case 'env':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties as StreamParser<unknown>);
      case 'diff':
      case 'patch':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/diff')).diff as StreamParser<unknown>);
      case 'swift':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/swift')).swift as StreamParser<unknown>);
      case 'pl':
      case 'pm':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/perl')).perl as StreamParser<unknown>);
      case 'r':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/r')).r as StreamParser<unknown>);
      case 'makefile':
      case 'mk':
        return legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell as StreamParser<unknown>);
      default:
        return null;
    }
  } catch {
    return null; // a chunk that failed to load: plain text
  }
}

const NAMES: Record<string, string> = {
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TypeScript JSX', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript JSX',
  py: 'Python', pyi: 'Python', json: 'JSON', jsonc: 'JSON', md: 'Markdown', markdown: 'Markdown', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS',
  yml: 'YAML', yaml: 'YAML', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', sql: 'SQL', xml: 'XML',
  svg: 'SVG', php: 'PHP', sh: 'Shell', bash: 'Shell', zsh: 'Shell', toml: 'TOML', dockerfile: 'Dockerfile', rb: 'Ruby', lua: 'Lua', ini: 'INI', env: 'Env',
  diff: 'Diff', patch: 'Diff', swift: 'Swift', pl: 'Perl', r: 'R', makefile: 'Makefile', txt: 'Plain text',
};
export function languageName(path: string): string {
  return NAMES[ext(path)] ?? 'Plain text';
}
