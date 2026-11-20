const encoder = new TextEncoder();

export const ESTIMATOR = "UTF-8 bytes ÷ 4 heuristic";

export function measure(text: string): { bytes: number; chars: number; estTokens: number } {
  const bytes = encoder.encode(text).length;
  const chars = Array.from(text).length;
  return { bytes, chars, estTokens: Math.ceil(bytes / 4) };
}
