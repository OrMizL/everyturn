// Browser rasterizer: the CLI's resvg, as WebAssembly. The wasm and the six fonts are bytes inside the bundle (see bytes-plugin.ts):
// nothing is fetched, which is what lets the page's CSP say connect-src 'none'.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasmBase64 from "@resvg/resvg-wasm/index_bg.wasm?bytes";
import { poster } from "@everyturn/core";
import interRegular from "../../../packages/core/assets/fonts/inter/Inter-Regular.ttf?bytes";
import interMedium from "../../../packages/core/assets/fonts/inter/Inter-Medium.ttf?bytes";
import interSemiBold from "../../../packages/core/assets/fonts/inter/Inter-SemiBold.ttf?bytes";
import interBold from "../../../packages/core/assets/fonts/inter/Inter-Bold.ttf?bytes";
import monoRegular from "../../../packages/core/assets/fonts/jetbrains-mono/JetBrainsMonoNL-Regular.ttf?bytes";
import monoMedium from "../../../packages/core/assets/fonts/jetbrains-mono/JetBrainsMonoNL-Medium.ttf?bytes";

// Keyed by the names in poster.fonts (the theme token file), so the order is the CLI's.
const FONT_DATA: Record<string, string> = {
  "Inter-Regular": interRegular, "Inter-Medium": interMedium, "Inter-SemiBold": interSemiBold, "Inter-Bold": interBold,
  "JetBrainsMonoNL-Regular": monoRegular, "JetBrainsMonoNL-Medium": monoMedium,
};

/** base64 text to bytes (atob, no fetch). */
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

let ready: Promise<Uint8Array[]> | undefined;

/** Compile the wasm and decode the six fonts once, from the bundled bytes. Safe to call repeatedly. */
export function loadRenderer(): Promise<Uint8Array[]> {
  ready ??= (async () => {
    await initWasm(decodeBase64(wasmBase64));
    return poster.fonts.map((name) => {
      const data = FONT_DATA[name];
      if (data === undefined) throw new Error("font asset missing");
      return decodeBase64(data);
    });
  })();
  // A failed load can be retried by the next call.
  ready.catch(() => { ready = undefined; });
  return ready;
}

export interface Exports { png: Uint8Array; outlinedSvg: string }

/** Rasterize the poster's source SVG: PNG at 1600 px wide, and the outlined SVG (no <text>), exactly as the CLI does. */
export async function rasterize(sourceSvg: string): Promise<Exports> {
  const fontBuffers = await loadRenderer();
  const resvg = new Resvg(sourceSvg, { font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: "Inter" }, fitTo: { mode: "width", value: 1600 } });
  try {
    const png = resvg.render().asPng();
    return { png, outlinedSvg: resvg.toString() };
  } finally {
    resvg.free();
  }
}
