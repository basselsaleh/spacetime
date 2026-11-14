// The app's look in one place: the strain color map (a lookup table shared by
// the slice and volume shaders, and the legend) and the styling of the near
// zone, horizons, probe and 3D guides. Chosen with a since-removed ?dev tuning
// panel (commit 117a614 has it and the other candidate color maps).

export type RGB = [number, number, number]; // sRGB, 0..1

export const LOOK = {
  nearZone: "#1c2230", // fill inside the near-zone ring: distinct from zero strain and the page
  holeRim: "#dfe6ff", // horizon rim and halo
  holeMinPx: 4, // minimum on-screen horizon radius, CSS px
  haloStrength: 0.6, // 0..1
  probeColor: "#eef1f8",
  probePx: 6, // probe marker radius, CSS px
  guideOpacity: 0.35, // 3D orbital axis and plane outline
  spinColor: "#eef1f8", // spin arrows and the orbital-axis guide
  spinLength: 3, // spin arrow length per unit |χ|, in horizon radii...
  spinMinPx: 28, // ...but at least this many CSS px per unit |χ|
} as const;

// Berlin, from Crameri's Scientific Colour Maps (F. Crameri,
// doi:10.5281/zenodo.1243862; MIT license): 17 samples from cmcrameri 1.10,
// negative (blue) end first, interpolated in OKLab.
const BERLIN =
  "9eb0ff 79abed 519fd3 3685ad 286886 1d4b61 14303e 111a20 190c09 2b0e01 411201 5b1d08 7d341e 9e513f be6f63 df8f89 ffadad";

// ---------------------------------------------------------------------------
// Color spaces: sRGB ⇄ OKLab (Björn Ottosson, 2020).

type Lab = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

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

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToHex(c: RGB): string {
  return "#" + c.map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// The color map.

const STOPS = BERLIN.split(" ").map((h) => srgbToOklab(hexToRgb(h)));

/** Color for a signed, already-saturated strain value s ∈ [−1, 1]. */
export function paletteColor(s: number): RGB {
  const x = ((s + 1) / 2) * (STOPS.length - 1);
  const i = Math.min(Math.max(Math.floor(x), 0), STOPS.length - 2);
  const f = x - i;
  return oklabToSrgb(STOPS[i].map((v, k) => v + (STOPS[i + 1][k] - v) * f) as Lab);
}

export const LUT_SIZE = 256;

/** RGBA8 lookup table, LUT_SIZE texels from s = −1 to +1. */
export function buildLut(): Uint8Array {
  const out = new Uint8Array(4 * LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const c = paletteColor(-1 + (2 * i) / (LUT_SIZE - 1));
    for (let k = 0; k < 3; k++) out[4 * i + k] = Math.round(Math.min(Math.max(c[k], 0), 1) * 255);
    out[4 * i + 3] = 255;
  }
  return out;
}

/** Paints the legend's ramp with the color map. */
export function setLegend(n = 17): void {
  const ramp = document.querySelector<HTMLElement>("#legend .ramp");
  if (!ramp) return;
  const parts = Array.from({ length: n }, (_, i) => {
    const s = -1 + (2 * i) / (n - 1);
    return `${rgbToHex(paletteColor(s))} ${((100 * i) / (n - 1)).toFixed(1)}%`;
  });
  ramp.style.background = `linear-gradient(90deg, ${parts.join(", ")})`;
}
