// Is this a small device — a phone or a small tablet — whose browser may end a tab well below 1 GB of memory (a
// reload that would lose unsaved edits)? There the previews use smaller caps (limits.ts SMALL, sniff.ts SMALL_CAPS):
// over one of them a file is offered for download, and the message says the preview is limited on this device.
//
// `navigator.deviceMemory` (Chromium: the device's RAM in GB, rounded and capped at 8) when the browser tells it: 4 or
// less is small. Safari and Firefox do not tell it: there a touch screen (`pointer: coarse`) whose shorter side is under
// 768 CSS pixels (phones, small tablets) is small. Decided once per page load (the screen, not the window: resizing a
// desktop window changes nothing).

export interface DeviceHints {
  /** navigator.deviceMemory (GB) where the browser has it */
  deviceMemory?: unknown;
  /** matchMedia('(pointer: coarse)') */
  coarse: boolean;
  /** the screen's shorter side, in CSS pixels */
  shortSide: number;
}

export const SMALL_SCREEN = 768;

export function isSmallDevice(h: DeviceHints): boolean {
  if (typeof h.deviceMemory === 'number' && Number.isFinite(h.deviceMemory) && h.deviceMemory > 0) return h.deviceMemory <= 4;
  return h.coarse && h.shortSide > 0 && h.shortSide < SMALL_SCREEN;
}

let small: boolean | null = null;

/** This page's answer (computed once). */
export function smallDevice(): boolean {
  if (small === null) {
    try {
      small = isSmallDevice({
        deviceMemory: (navigator as Navigator & { deviceMemory?: unknown }).deviceMemory,
        coarse: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
        shortSide: Math.min(screen.width, screen.height),
      });
    } catch {
      small = false;
    }
  }
  return small;
}
