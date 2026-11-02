/** Homepage experiment. Preview traffic is excluded from GA. */
export const EXPERIMENT_ID = process.env.NEXT_PUBLIC_HOMEPAGE_EXPERIMENT_ID || "homepage_v2_2026_10";
export type Assignment = { variant: "a" | "b"; preview: boolean; mode: "ab" | "v1" | "v2" };
const KEY = `buywise:${EXPERIMENT_ID}`;
let current: Assignment | null = null;
export function experimentContext(): Assignment | null { return current; }
export function assignExperiment(): Assignment {
  if (current) return current;
  const configuredMode = process.env.NEXT_PUBLIC_HOMEPAGE_EXPERIMENT;
  const mode = configuredMode === "ab" || configuredMode === "v1" ? configuredMode : "v2";
  const override = new URLSearchParams(window.location.search).get("variant");
  try {
    if (override === "reset") sessionStorage.removeItem(`${KEY}:preview`);
    if (override === "a" || override === "b") sessionStorage.setItem(`${KEY}:preview`, override);
    const preview = sessionStorage.getItem(`${KEY}:preview`);
    if (preview === "a" || preview === "b") return current = { variant: preview, preview: true, mode };
    const stored = localStorage.getItem(KEY);
    const variant = mode === "v1" ? "a" : mode === "v2" ? "b" : stored === "a" || stored === "b" ? stored : crypto.getRandomValues(new Uint32Array(1))[0] % 2 ? "b" : "a";
    if (mode === "ab") localStorage.setItem(KEY, variant);
    return current = { variant, preview: false, mode };
  } catch {
    return current = { variant: mode === "v1" ? "a" : "b", preview: true, mode };
  }
}
