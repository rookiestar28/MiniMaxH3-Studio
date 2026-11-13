// Emit only to stdout; callers choose a destination and the check never rewrites a fixture.
const { TEXT_PRESETS } = await import(
  new URL("../../src/components/nle/nleTextPresets.ts", import.meta.url).href
);
process.stdout.write(JSON.stringify(TEXT_PRESETS, null, 2) + "\n");
export {};
