// ?dev: a temporary panel for tuning the look (look.ts) live and comparing
// candidates. Settings persist in localStorage (only with ?dev; without it the
// app uses DEFAULT_LOOK), and "Copy settings" puts them on the clipboard.
//
// Keys: [ and ] cycle palettes; S swaps with the snapshot.

import { CLASSIC_LOOK, cssGradient, DEFAULT_LOOK, PALETTES, type Look } from "./look";

const STORAGE_KEY = "spacetime.bbh.look";

export function loadLook(): Look {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Look> | null;
    const look = { ...DEFAULT_LOOK, ...(saved ?? {}) };
    if (!(look.palette in PALETTES)) look.palette = DEFAULT_LOOK.palette;
    return look;
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

function saveLook(look: Look) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(look));
  } catch {
    // storage unavailable (private window): settings last for this page only
  }
}

export function setupDevPanel(parent: HTMLElement, initial: Look, apply: (look: Look) => void): void {
  let look: Look = { ...initial };
  let snapshot: Look | null = null;

  const panel = document.createElement("details");
  panel.id = "dev-panel";
  panel.className = "panel";
  panel.open = true;
  panel.innerHTML = `<summary>Look · dev</summary><div class="dev-body"></div>`;
  parent.appendChild(panel);
  const body = panel.querySelector<HTMLElement>(".dev-body")!;
  const refreshers: (() => void)[] = [];

  const commit = () => {
    apply(look);
    saveLook(look);
    for (const r of refreshers) r();
  };
  const set = <K extends keyof Look>(key: K, value: Look[K]) => {
    look = { ...look, [key]: value };
    commit();
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const heading = (text: string) => body.appendChild(el("div", "dev-h", text));
  const row = (label: string) => {
    const r = el("label", "dev-row");
    r.appendChild(el("span", "", label));
    body.appendChild(r);
    return r;
  };

  /** Segmented choice of string values. */
  const toggle = <K extends keyof Look>(label: string, key: K, options: [Look[K], string][]) => {
    const r = row(label);
    const group = el("div", "toggle");
    const buttons = options.map(([value, text]) => {
      const b = el("button", "", text);
      b.type = "button";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        set(key, value);
      });
      group.appendChild(b);
      return [value, b] as const;
    });
    r.appendChild(group);
    refreshers.push(() => buttons.forEach(([v, b]) => b.setAttribute("aria-pressed", String(look[key] === v))));
  };
  const color = (label: string, key: "nearZone" | "holeRim" | "probeColor") => {
    const r = row(label);
    const input = el("input");
    input.type = "color";
    input.addEventListener("input", () => set(key, input.value));
    r.appendChild(input);
    refreshers.push(() => (input.value = look[key]));
  };
  const slider = (
    label: string,
    key: "holeMinPx" | "haloStrength" | "probePx" | "guideOpacity",
    min: number,
    max: number,
    step: number,
  ) => {
    const r = row(label);
    const input = el("input");
    Object.assign(input, { type: "range", min, max, step });
    const out = el("output");
    input.addEventListener("input", () => set(key, Number(input.value)));
    r.append(input, out);
    refreshers.push(() => {
      input.value = String(look[key]);
      out.textContent = String(look[key]);
    });
  };

  // Presets and A/B.
  const presets = el("div", "dev-buttons");
  const button = (text: string, onClick: () => void, title?: string) => {
    const b = el("button", "", text);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    presets.appendChild(b);
    return b;
  };
  button("Proposed", () => ((look = { ...DEFAULT_LOOK }), commit()), "The defaults in look.ts");
  button("Classic", () => ((look = { ...CLASSIC_LOOK }), commit()), "The look before this round of tuning");
  button("Snapshot", () => ((snapshot = { ...look }), commit()), "Remember the current settings as B");
  const swap = button("Swap (S)", () => swapSnapshot(), "Swap the current settings with the snapshot");
  refreshers.push(() => (swap.disabled = snapshot === null));
  body.appendChild(presets);
  const swapSnapshot = () => {
    if (!snapshot) return;
    [look, snapshot] = [snapshot, look];
    commit();
  };

  // Palettes as clickable swatches.
  heading("Colour map  ·  [ ] to cycle");
  const list = el("div", "dev-palettes");
  const keys = Object.keys(PALETTES);
  const swatches = keys.map((key) => {
    const b = el("button", "dev-swatch");
    b.type = "button";
    const bar = el("span", "bar");
    bar.style.background = cssGradient(PALETTES[key]);
    b.append(bar, el("span", "name", PALETTES[key].label));
    b.addEventListener("click", () => set("palette", key));
    list.appendChild(b);
    return [key, b] as const;
  });
  body.appendChild(list);
  refreshers.push(() => swatches.forEach(([k, b]) => b.setAttribute("aria-pressed", String(look.palette === k))));
  toggle("Saturation", "curve", [["tanh", "tanh"], ["soft", "soft"]]);
  color("Near zone", "nearZone");

  heading("Horizons");
  toggle("Style", "holeStyle", [["thin", "thin"], ["rim", "rim"], ["halo", "halo"]]);
  color("Rim / halo", "holeRim");
  slider("Min radius px", "holeMinPx", 1.5, 10, 0.5);
  slider("Halo", "haloStrength", 0, 1, 0.05);

  heading("Probe");
  toggle("Style", "probeStyle", [["ring", "ring"], ["dot", "dot"], ["ball", "ball"]]);
  color("Colour", "probeColor");
  slider("Radius px", "probePx", 2, 12, 0.5);

  heading("3D");
  slider("Guides", "guideOpacity", 0, 1, 0.05);

  // Export.
  const out = el("textarea", "dev-out");
  out.readOnly = true;
  out.rows = 4;
  const copy = el("button", "", "Copy settings");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    out.value = JSON.stringify(look, null, 1);
    out.select();
    try {
      await navigator.clipboard.writeText(out.value);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Select and copy below";
    }
    setTimeout(() => (copy.textContent = "Copy settings"), 1500);
  });
  const exportRow = el("div", "dev-buttons");
  exportRow.appendChild(copy);
  body.append(exportRow, out);

  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || e.metaKey || e.ctrlKey) return;
    if (e.key === "[" || e.key === "]") {
      const i = keys.indexOf(look.palette);
      set("palette", keys[(i + (e.key === "]" ? 1 : keys.length - 1)) % keys.length]);
    } else if (e.key === "s" || e.key === "S") {
      swapSnapshot();
    }
  });

  commit();
}
