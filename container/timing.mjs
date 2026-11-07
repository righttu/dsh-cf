// Measure local stages with a monotonic clock; never log prompts or model text.
export async function timeStage(timing, name, operation, clock = () => performance.now()) {
  const started = clock();
  timing.phase = name;
  try { return await operation(); }
  finally { timing[name + 'Ms'] = Math.max(0, clock() - started); }
}
