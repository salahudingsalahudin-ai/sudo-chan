// Native X11 regions, in window-local DIP coordinates. Leave room for the
// animated SVG, shadows, grip and both dock labels (including paused text).
// Unlike pointer polling, these regions keep accepting input after the pointer
// crosses from a native Wayland application into our XWayland overlay.
export function overlayShape(width: number, height: number, speech: boolean | 'approval') {
  const region = (left: number, top: number, right: number, bottom: number) => {
    const x = Math.floor(width * left), y = Math.floor(height * top);
    return { x, y, width: Math.ceil(width * right) - x, height: Math.ceil(height * bottom) - y };
  };
  const regions = [
    region(.08, .18, .92, .9), // Bot, halo and shadow.
    region(.3, .08, .7, .22), // Native drag grip.
    region(.02, .83, .98, .99), // Chat pill and gear, including small/paused mode.
  ];
  if (speech === 'approval') regions.push(region(.02, 0, .98, .6)); // Compact approval panel: command text and two buttons.
  else if (speech) regions.push(region(.02, 0, .98, .29));
  return regions;
}
