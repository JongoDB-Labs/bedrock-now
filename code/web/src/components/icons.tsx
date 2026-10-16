// Stroke icons on a 20×20 grid, drawn like the portal's nav icons (1.6 stroke, round caps). Static path data only.
const P: Record<string, string> = {
  files: 'M4 3h7l4 4v10H4zM11 3v4h4',
  folder: 'M3 6V5a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  folderOpen: 'M3 15V5a1 1 0 0 1 1-1h4l2 2h5a1 1 0 0 1 1 1v1M3 15l2.2-6.2A1 1 0 0 1 6.1 8H17a1 1 0 0 1 1 1.3L16 15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  file: 'M5 3h6l4 4v10H5zM11 3v4h4',
  history: 'M3.5 10a6.5 6.5 0 1 0 2-4.7M3 3v3h3M10 6.5V10l2.5 1.5',
  search: 'M8.5 14a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM17 17l-4.5-4.5',
  plus: 'M10 4v12M4 10h12',
  chevronRight: 'M8 5l5 5-5 5',
  chevronDown: 'M5 8l5 5 5-5',
  chevronUp: 'M5 12l5-5 5 5',
  close: 'M5 5l10 10M15 5L5 15',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
  send: 'M10 16V4M5 9l5-5 5 5',
  stop: 'M6 6h8v8H6z',
  clip: 'M15.5 9.5l-5.8 5.8a3.5 3.5 0 0 1-5-5L11 4a2.3 2.3 0 0 1 3.3 3.3l-6.2 6.2a1.2 1.2 0 0 1-1.7-1.7L12 6.2',
  at: 'M13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm0 0v1.3a2 2 0 0 0 4 0V10a7 7 0 1 0-2.8 5.6',
  slash: 'M13 3L7 17',
  check: 'M4 10.5l4 4 8-9',
  alert: 'M10 3l8 14H2zM10 8v4M10 14.5h.01',
  terminal: 'M3 4h14v12H3zM6 8l3 2-3 2M11 12h3',
  sidebar: 'M3 4h14v12H3zM8 4v12',
  panelBottom: 'M3 4h14v12H3zM3 12h14',
  panelRight: 'M3 4h14v12H3zM12 4v12',
  refresh: 'M16 10a6 6 0 1 1-1.8-4.3M16 3.5V6h-2.5',
  upload: 'M10 13V3M6 7l4-4 4 4M4 13v3h12v-3',
  newFolder: 'M3 6V5a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM10 9v4M8 11h4',
  newFile: 'M5 3h6l4 4v10H5zM11 3v4h4M10 10v4M8 12h4',
  collapse: 'M6 8l4-4 4 4M6 12l4 4 4-4',
  pencil: 'M13.5 4.5l2 2L7 15l-3 1 1-3z',
  fork: 'M6 4v6a3 3 0 0 0 3 3h2a3 3 0 0 1 3 3M14 4v8M6 4a1.5 1.5 0 1 0 0 .01M14 4a1.5 1.5 0 1 0 0 .01',
  copy: 'M7 7h9v9H7zM4 13V4h9',
  external: 'M11 4h5v5M16 4l-7 7M14 12v4H4V6h4',
  diff: 'M6 3v8M2 7h8M12 13h6M14 3l-4 14',
  model: 'M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5zM10 10v7.5M10 10l6.5-3.75M10 10L3.5 6.25',
  shield: 'M10 2.5l6 2.5v5c0 3.6-2.6 6.3-6 7.5-3.4-1.2-6-3.9-6-7.5V5z',
  gauge: 'M3.5 14a7 7 0 1 1 13 0M10 14l3-5',
  plug: 'M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0zM10 15v3',
  server: 'M3 4h14v5H3zM3 11h14v5H3zM6 6.5h.01M6 13.5h.01',
  keyboard: 'M2.5 5h15v10h-15zM5.5 8h.01M8.5 8h.01M11.5 8h.01M14.5 8h.01M6 12h8',
  play: 'M6 4l10 6-10 6z',
  dot: 'M10 10h.01',
  brain: 'M7.5 4.5A2.5 2.5 0 0 0 5 7a2.5 2.5 0 0 0-1 4.8A2.5 2.5 0 0 0 7.5 15.5h.5V4.5zM12.5 4.5A2.5 2.5 0 0 1 15 7a2.5 2.5 0 0 1 1 4.8 2.5 2.5 0 0 1-3.5 3.7H12V4.5z',
  globe: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM3 10h14M10 3c2 2 2.8 4.3 2.8 7S12 15 10 17c-2-2-2.8-4.3-2.8-7S8 5 10 3z',
  list: 'M7 5h10M7 10h10M7 15h10M3.5 5h.01M3.5 10h.01M3.5 15h.01',
  book: 'M4 4.5A1.5 1.5 0 0 1 5.5 3H16v12H5.5A1.5 1.5 0 0 0 4 16.5zM4 16.5A1.5 1.5 0 0 0 5.5 18H16',
  image: 'M3 4h14v12H3zM3 13l4-4 4 4 2-2 4 4M13 7.5h.01',
  menu: 'M3 6h14M3 10h14M3 14h14',
  sparkle: 'M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6zM15.5 14l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  download: 'M10 3v10M6 9l4 4 4-4M4 16h12',
  trash: 'M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10',
  code: 'M7 6l-4 4 4 4M13 6l4 4-4 4M11.5 4l-3 12',
  // previews: a browser window, the viewport presets, and a listening port
  window: 'M2.5 4h15v12h-15zM2.5 7.5h15M5 5.75h.01M7 5.75h.01',
  monitor: 'M2.5 4h15v9h-15zM7 16.5h6M10 13v3.5',
  tablet: 'M5 2.5h10v15H5zM9 15h2',
  phone: 'M6.5 2.5h7v15h-7zM9.25 15h1.5',
  port: 'M10 3v4M6 7h8v4a4 4 0 0 1-8 0zM10 15v2.5M7.5 17.5h5',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, class: cls }: { name: string; size?: number; class?: string }) {
  return (
    <svg class={`ic${cls ? ' ' + cls : ''}`} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={P[name] ?? P.dot} />
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg class="spin" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="7" />
    </svg>
  );
}
