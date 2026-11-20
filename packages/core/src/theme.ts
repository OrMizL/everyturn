// Single theme token file.
const base = {
  font: `"Inter", system-ui, sans-serif`, // resvg: family name must be exactly "Inter"
  mono: `"JetBrains Mono NL", ui-monospace, monospace`, // all numbers too (resvg ignores tnum)
};

export const light = {
  ...base,
  ink: "#17191E", muted: "#5A606B", rule: "#DCDDD8", bar: "#2A2D34", paper: "#F7F7F4",
  surface: "#FFFFFF", track: "#E6E7E2",
  conflict: "#B33D0C", conflictTint: "#FBEAE2", onConflict: "#FFFFFF",
  duplicate: "#1E5AA0", duplicateTint: "#E5EDF8", onDuplicate: "#FFFFFF",
  focus: "#1E5AA0", controlBorder: "#7A808B",
};

export type Theme = typeof light;

/** Defined for later; the poster is light-only in week one. */
export const dark: Theme = {
  ...base,
  ink: "#ECEDEF", muted: "#A3A9B4", rule: "#30343C", bar: "#D7DAE0", paper: "#121417",
  surface: "#1B1E23", track: "#272B32",
  conflict: "#FF8D5C", conflictTint: "#3A2219", onConflict: "#121417",
  duplicate: "#83B5F2", duplicateTint: "#1B2A3D", onDuplicate: "#121417",
  focus: "#83B5F2", controlBorder: "#6E7581",
};

export const theme = light; // back-compat for table.ts

export const poster = {
  width: 1600, height: 2000, margin: 96, footerBottom: 56,
  cropTop: 200, cropBottom: 1800, // 1:1 centre crop: hero, sources, finding must sit inside
  eyebrow: 26, heroNumber: 176, heroUnit: 64, findingsLine: 30, subline: 30,
  label: 36, path: 26, number: 36, share: 24, badge: 24, badgeHeight: 44,
  ruleText: 30, ruleLine: 42, ruleMaxLines: 3, ruleMeta: 24,
  footer: 24, footerMark: 34, footerHandle: 30, footerMeta: 22,
  rowHeight: 76, maxRows: 10, groupAbove: 24, groupMoreShare: 0.35,
  flagsX: 704, barX: 800, barW: 520, barH: 26, barMin: 4, numX: 1504,
  quoteW: 580, quoteBar: 6,
  radius: 12, badgeRadius: 6, connector: 4, dupDash: "8 6", badgeDash: "8 5",
  monoAdvance: 0.6, // JetBrains Mono: exact, used for middle truncation
  fonts: ["Inter-Regular", "Inter-Medium", "Inter-SemiBold", "Inter-Bold",
    "JetBrainsMonoNL-Regular", "JetBrainsMonoNL-Medium"],
};
