// Original silhouettes. Rasterized locally; there are no image or network dependencies.
export const silhouettes = {
  core: '<circle cx="128" cy="128" r="22"/><path d="M38 137C10 73 84 20 148 36C220 54 225 124 187 151C211 96 172 60 125 66C70 70 51 102 65 133C84 170 140 185 186 164C157 210 81 206 47 167Z"/><path d="M215 100C250 163 180 231 109 217C53 206 28 156 48 125C44 176 94 196 140 185C191 174 206 145 192 119Z"/>',
  female: '<path d="M54 169C57 144 49 111 63 77C78 35 145 26 176 62C202 90 191 130 204 173L176 186L158 159V174C194 180 213 202 219 233H37C43 201 66 180 98 174V156L76 187Z"/><ellipse cx="127" cy="111" rx="39" ry="49"/><path fill="black" d="M85 95C113 99 147 71 148 63C129 51 90 58 85 95Z"/>',
  male: '<path d="M83 93L76 74L87 51L111 43L125 33L142 45L167 48L182 75L174 98Z"/><ellipse cx="128" cy="111" rx="43" ry="49"/><path d="M105 148H151V176C185 180 212 199 221 233H35C45 201 70 180 105 176Z"/>',
  cat: '<path d="M65 107L52 39L106 74Q128 65 150 74L204 39L191 107Q212 147 181 177Q173 188 161 192L176 233H80L95 192Q46 178 54 140Z"/><path fill="black" d="M78 129L105 136L83 143ZM178 129L151 136L173 143ZM117 157H139L128 169Z"/>',
  dog: '<path d="M83 75Q128 47 173 75L196 68Q221 88 221 144Q212 175 184 148L175 171L153 191L176 233H80L103 191L81 171L72 148Q44 175 35 144Q35 88 60 68Z"/><ellipse fill="black" cx="128" cy="155" rx="16" ry="11"/><circle fill="black" cx="98" cy="119" r="6"/><circle fill="black" cx="158" cy="119" r="6"/>',
  rabbit: '<ellipse cx="96" cy="66" rx="19" ry="53" transform="rotate(-13 96 66)"/><ellipse cx="161" cy="66" rx="19" ry="53" transform="rotate(13 161 66)"/><ellipse cx="128" cy="150" rx="64" ry="56"/><path d="M94 186Q128 173 162 186L183 233H73Z"/><ellipse fill="black" cx="103" cy="141" rx="5" ry="8"/><ellipse fill="black" cx="153" cy="141" rx="5" ry="8"/><path fill="black" d="M119 164H137L128 174Z"/>',
  fox: '<path d="M47 38L107 85H149L209 38L192 130L204 149L128 207L52 149L64 130Z"/><path d="M100 188H156L175 233H81Z"/><path fill="black" d="M78 127L111 142L93 148ZM178 127L145 142L163 148ZM116 180H140L128 192Z"/>',
  panda: '<circle cx="72" cy="69" r="30"/><circle cx="184" cy="69" r="30"/><ellipse cx="128" cy="129" rx="78" ry="73"/><path d="M88 187H168L188 233H68Z"/><ellipse fill="black" cx="94" cy="123" rx="19" ry="25" transform="rotate(25 94 123)"/><ellipse fill="black" cx="162" cy="123" rx="19" ry="25" transform="rotate(-25 162 123)"/><circle cx="97" cy="120" r="6"/><circle cx="159" cy="120" r="6"/><ellipse fill="black" cx="128" cy="164" rx="12" ry="9"/>',
  bird: '<path d="M39 183L59 141Q63 107 111 111Q109 54 151 48Q182 46 190 79L222 94L190 106Q190 166 145 188L112 220L108 191L69 213L82 184Z"/><circle fill="black" cx="162" cy="80" r="6"/><path fill="black" d="M85 140Q122 137 154 114Q140 161 98 168Z"/>',
} as const;
export type Shape = keyof typeof silhouettes;
export const characters: Shape[] = ['core', 'female', 'male'];
export const creatures: Shape[] = ['cat', 'dog', 'rabbit', 'fox', 'panda', 'bird'];
export const colors = { cyan: '#63e8ff', pink: '#ff91c7', gold: '#ffd47a', green: '#8af5b0', violet: '#c1a1ff', white: '#f4fbff' } as const;
export const densities = { low: 6000, medium: 10000, high: 14000 } as const;
export type Settings = { shape: Shape; color: keyof typeof colors; glow: number; density: keyof typeof densities; name: string; threshold: number };
export const storageKey = 'sudo-chan-portrait-v1';
export function defaults(weak = false): Settings { return { shape: 'core', color: 'cyan', glow: 1, density: weak ? 'low' : 'high', name: '', threshold: 90 }; }
export function plainName(value: string) { return Array.from(value.replace(/[<>\u0000-\u001f\u007f]/g, '')).slice(0, 20).join(''); }
export function restoreSettings(value: unknown, weak = false): Settings {
  const result = defaults(weak);
  if (!value || typeof value !== 'object') return result;
  const input = value as Record<string, unknown>;
  for (const [key, allowed] of [['shape', silhouettes], ['color', colors], ['density', densities]] as const) {
    if (typeof input[key] === 'string' && Object.hasOwn(allowed, input[key] as string)) Object.assign(result, { [key]: input[key] });
  }
  if (typeof input.name === 'string') result.name = plainName(input.name);
  if (typeof input.glow === 'number' && Number.isFinite(input.glow)) result.glow = Math.max(.3, Math.min(2, input.glow));
  if (typeof input.threshold === 'number' && Number.isFinite(input.threshold)) result.threshold = Math.round(Math.max(0, Math.min(250, input.threshold)));
  return result;
}
export function svgSource(shape: Shape) { return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><g fill="white">${silhouettes[shape]}</g></svg>`; }
export async function rasterize(shape: Shape): Promise<ImageData> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgSource(shape))}`;
  await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, 256, 256);
  return ctx.getImageData(0, 0, 256, 256);
}
export async function readPicture(file: File): Promise<ImageData> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const scale = 256 / Math.max(image.naturalWidth, image.naturalHeight);
    const w = Math.max(1, Math.round(image.naturalWidth * scale)), h = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally { URL.revokeObjectURL(url); }
}
export function samplePixels(image: ImageData, count: number, threshold = 90, uploaded = false): Float32Array | null {
  const { data, width, height } = image;
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { transparent = true; break; }
  const eligible: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const luminance = data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722;
    const value = uploaded && transparent ? data[i + 3] : luminance;
    if (data[i + 3] > 0 && value > threshold) eligible.push(i / 4);
  }
  if (!eligible.length) return null;
  let seed = 8191;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const pixel = eligible[Math.floor(random() * eligible.length)];
    points[i * 3] = ((pixel % width + random()) - width / 2) / Math.max(width, height) * 3.5;
    points[i * 3 + 1] = (height / 2 - (Math.floor(pixel / width) + random())) / Math.max(width, height) * 3.5;
    points[i * 3 + 2] = (random() - .5) * .24;
  }
  return points;
}
