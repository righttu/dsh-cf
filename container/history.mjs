// A user-facing task transcript, not the harness's internal tool/event log.
// Stored atomically with sessionId and the active task in /data/state.json.
export function updateHistory(state) {
  if (!Array.isArray(state.history)) state.history = [];
  const task = state.task;
  // Legacy bridge versions did not persist prompts. Never invent missing text.
  if (!task?.id || typeof task.prompt !== 'string') return;
  const index = state.history.findIndex(item => item.id === task.id);
  const entry = { ...task };
  if (index < 0) state.history.push(entry);
  else state.history[index] = entry;
}
export function historyView(state) {
  const history = Array.isArray(state.history) ? state.history : [];
  const entries = [];
  let bytes = 0;
  for (const task of history.slice(-50).reverse()) {
    const entry = { ...task };
    for (const key of ['prompt', 'response', 'error']) {
      if (typeof entry[key] === 'string' && entry[key].length > 4000) {
        entry[key] = entry[key].slice(0, 4000); entry.truncated = true;
      }
    }
    const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (bytes + size > 88000) break;
    bytes += size; entries.unshift(entry);
  }
  return { available: true, entries, total: history.length, sessionId: state.sessionId || null };
}
