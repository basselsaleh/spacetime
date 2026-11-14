// The app's look in one place: the strain colour map (as a lookup table shared
// by the slice and volume shaders, the legend and the dev panel), the
// saturation curve, and the styling of the near zone, horizons, probe and 3D
// guides. `?dev` opens a panel (devpanel.ts) that edits a `Look` live.

export type RGB = [number, number, number]; // sRGB, 0..1

export interface Palette {
  label: string;
  /** Colour for a signed, already-saturated strain value s ∈ [−1, 1]. */
  color(s: number): RGB;
}

export type Curve = "tanh" | "soft";
export type HoleStyle = "thin" | "rim" | "halo";
export type ProbeStyle = "ball" | "ring" | "dot";

export interface Look {
  palette: string;
  curve: Curve;
  nearZone: string; // hex: fill inside the near-zone ring
  holeStyle: HoleStyle;
  holeRim: string; // hex
  holeMinPx: number; // minimum on-screen horizon radius, CSS px
  haloStrength: number; // 0..1
  probeStyle: ProbeStyle;
  probeColor: string; // hex
  probePx: number; // marker radius, CSS px
  guideOpacity: number; // 3D orbital axis and plane outline
}

export const DEFAULT_LOOK: Look = {
  palette: "ember",
  curve: "soft",
  nearZone: "#1c2230",
  holeStyle: "halo",
  holeRim: "#dfe6ff",
  holeMinPx: 4,
  haloStrength: 0.6,
  probeStyle: "ring",
  probeColor: "#eef1f8",
  probePx: 6,
  guideOpacity: 0.35,
};

/** The look before this round of tuning, for comparison. */
export const CLASSIC_LOOK: Look = {
  palette: "classic",
  curve: "tanh",
  nearZone: "#090a0e",
  holeStyle: "thin",
  holeRim: "#ebf0ff",
  holeMinPx: 2.5,
  haloStrength: 0,
  probeStyle: "ball",
  probeColor: "#ffcc73",
  probePx: 5,
  guideOpacity: 0.8,
};

// ---------------------------------------------------------------------------
// Colour spaces: sRGB ⇄ OKLab (Björn Ottosson, 2020).

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

type Lab = [number, number, number];

function srgbToOklab([r8, g8, b8]: RGB): Lab {
  const r = toLinear(r8), g = toLinear(g8), b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → linear sRGB (may be out of gamut). */
function oklabToLinear([L, a, b]: Lab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLab → sRGB, reducing chroma (keeping lightness and hue) to fit the gamut. */
function oklabToSrgb([L, a, b]: Lab): RGB {
  const inGamut = (c: RGB) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let k = 1;
  if (!inGamut(oklabToLinear([L, a, b]))) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = 0.5 * (lo + hi);
      if (inGamut(oklabToLinear([L, mid * a, mid * b]))) lo = mid;
      else hi = mid;
    }
    k = lo;
  }
  return oklabToLinear([L, k * a, k * b]).map((v) => toSrgb(Math.min(Math.max(v, 0), 1))) as RGB;
}

const lch = (L: number, C: number, hDeg: number): Lab => {
  const h = (hDeg * Math.PI) / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
};

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: RGB): string {
  return "#" + c.map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Palettes.

/** The original map: near-black ↔ blue / orange, mixed in sRGB. */
function classic(): Palette {
  const mid: RGB = [0.06, 0.07, 0.1];
  const neg: RGB = [0.3, 0.58, 1.0];
  const pos: RGB = [1.0, 0.6, 0.22];
  return {
    label: "Classic (before tuning)",
    color(s) {
      const end = s < 0 ? neg : pos;
      const t = Math.abs(s);
      return mid.map((m, i) => m + (end[i] - m) * t) as RGB;
    },
  };
}

/**
 * A dark-centred diverging map built in OKLCH: lightness rises linearly from
 * the centre to matched end lightness on both sides, chroma rises faster
 * (√t) so the low end stays coloured rather than muddy.
 */
function oklch(
  label: string,
  o: { Lmid: number; Cmid: number; hmid: number; Lend: number; Cend: number; hneg: number; hpos: number },
): Palette {
  const [, am, bm] = lch(o.Lmid, o.Cmid, o.hmid);
  return {
    label,
    color(s) {
      const t = Math.abs(s);
      const [L, a, b] = lch(o.Lmid + (o.Lend - o.Lmid) * t, o.Cend * Math.sqrt(t), s < 0 ? o.hneg : o.hpos);
      return oklabToSrgb([L, a + am * (1 - t), b + bm * (1 - t)]);
    },
  };
}

/** A map given as evenly spaced sRGB stops (negative end first), interpolated in OKLab. */
function stops(label: string, hexes: string): Palette {
  const labs = hexes.split(" ").map((h) => srgbToOklab(hexToRgb(h)));
  return {
    label,
    color(s) {
      const x = ((s + 1) / 2) * (labs.length - 1);
      const i = Math.min(Math.floor(x), labs.length - 2);
      const f = x - i;
      return oklabToSrgb(labs[i].map((v, k) => v + (labs[i + 1][k] - v) * f) as Lab);
    },
  };
}

// Crameri's Scientific Colour Maps (F. Crameri, doi:10.5281/zenodo.1243862; MIT
// licence), 17 samples each from cmcrameri 1.10. Managua is reversed so that
// negative is blue.
const CRAMERI = {
  berlin: "9eb0ff 79abed 519fd3 3685ad 286886 1d4b61 14303e 111a20 190c09 2b0e01 411201 5b1d08 7d341e 9e513f be6f63 df8f89 ffadad",
  vanimo: "ffcdfd e6a0dc cd78bd b2589f 923e80 692a5b 401b37 24141e 1a1513 1c2011 2a3716 3d551d 527227 678e32 7fae47 9ed56e befda5",
  lisbon: "e6e5ff bbc6e5 90a7cc 6889b3 416a97 244c74 16334f 111f2e 171919 2a281b 454029 625c3a 817a4e a29a67 c3bc89 e2deb1 ffffd9",
  managua: "81e7ff 76c9ed 6bacdb 6190c8 5877b5 505e9d 4c4781 4e3362 572949 692b3c 813939 9a4c3d b16243 c5794a d89353 ebb05d ffcf67",
  vik: "001261 022b71 034481 0c5e92 307da6 619ebd 94bed2 c6dbe6 ece5e0 e9cab8 dbaa8d cf8c66 c27041 b2511d 912d06 731406 590008",
};

export const PALETTES: Record<string, Palette> = {
  classic: classic(),
  ember: oklch("Blue / orange · OKLab, matched", {
    Lmid: 0.2, Cmid: 0.015, hmid: 265, Lend: 0.76, Cend: 0.15, hneg: 252, hpos: 58,
  }),
  tealMagenta: oklch("Teal / magenta · OKLab", {
    Lmid: 0.2, Cmid: 0.01, hmid: 280, Lend: 0.76, Cend: 0.15, hneg: 195, hpos: 350,
  }),
  blueRed: oklch("Blue / red · OKLab", {
    Lmid: 0.2, Cmid: 0.01, hmid: 280, Lend: 0.72, Cend: 0.16, hneg: 255, hpos: 25,
  }),
  cyanAmber: oklch("Cyan / amber · OKLab", {
    Lmid: 0.2, Cmid: 0.01, hmid: 250, Lend: 0.8, Cend: 0.14, hneg: 220, hpos: 80,
  }),
  berlin: stops("Berlin (Crameri)", CRAMERI.berlin),
  managua: stops("Managua (Crameri, reversed)", CRAMERI.managua),
  vanimo: stops("Vanimo (Crameri)", CRAMERI.vanimo),
  lisbon: stops("Lisbon (Crameri)", CRAMERI.lisbon),
  vik: stops("Vik (Crameri, light centre)", CRAMERI.vik),
};

export const LUT_SIZE = 256;

/** RGBA8 lookup table, LUT_SIZE texels from s = −1 to +1. */
export function buildLut(palette: Palette): Uint8Array {
  const out = new Uint8Array(4 * LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const c = palette.color(-1 + (2 * i) / (LUT_SIZE - 1));
    for (let k = 0; k < 3; k++) out[4 * i + k] = Math.round(Math.min(Math.max(c[k], 0), 1) * 255);
    out[4 * i + 3] = 255;
  }
  return out;
}

/** CSS gradient of a palette from s = −1 to +1, for the legend. */
export function cssGradient(palette: Palette, n = 17): string {
  const parts = Array.from({ length: n }, (_, i) => {
    const s = -1 + (2 * i) / (n - 1);
    return `${rgbToHex(palette.color(s))} ${((100 * i) / (n - 1)).toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

/** Applies the parts of a look that live in the page (legend). */
export function applyLookToPage(look: Look): void {
  const ramp = document.querySelector<HTMLElement>("#legend .ramp");
  if (ramp) ramp.style.background = cssGradient(PALETTES[look.palette] ?? PALETTES[DEFAULT_LOOK.palette]);
}
