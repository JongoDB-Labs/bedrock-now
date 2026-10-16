// Types for preview-fixtures.mjs (the unit tests import it).
export function png(w: number, h: number, pixel: (x: number, y: number) => number[], claim?: [number, number]): Buffer;
export function previewFiles(opts?: { big?: boolean }): Record<string, string | Buffer>;
