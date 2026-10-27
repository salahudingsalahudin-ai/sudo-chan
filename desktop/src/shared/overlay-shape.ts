import { PANEL_HEIGHT, type OverlayPanel } from './overlay-panels.ts';

// Native X11 regions, in window-local DIP coordinates. Leave room for the
// animated SVG, shadows, grip and both dock labels (including paused text).
// Unlike pointer polling, these regions keep accepting input after the pointer
// crosses from a native Wayland application into our XWayland overlay.
//
// `panel` is the single visible top panel (see overlay-panels.ts). Legacy callers may still pass
// a boolean (a one-line bubble) plus `tall` (a panel with buttons).
export function overlayShape(width: number, height: number, panel: boolean | OverlayPanel | null = false, tall = false) {
  const region = (left: number, top: number, right: number, bottom: number) => {
    const x = Math.floor(width * left), y = Math.floor(height * top);
    return { x, y, width: Math.ceil(width * right) - x, height: Math.ceil(height * bottom) - y };
  };
  const regions = [
    region(.08, .18, .92, .9), // Bot, halo and shadow.
    region(.3, .08, .7, .22), // Native drag grip.
    region(.02, .83, .98, .99), // Chat pill and gear, including small/paused mode.
  ];
  const kind: OverlayPanel | null = typeof panel === 'string'
    ? (panel === ('approval' as string) || panel in PANEL_HEIGHT ? panel : 'caption')
    : panel === true ? (tall ? 'consent' : 'caption') : (tall ? 'consent' : null);
  if (kind) regions.push(region(.02, 0, .98, PANEL_HEIGHT[kind]));
  return regions;
}
