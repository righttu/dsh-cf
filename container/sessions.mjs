// Session registry is stored with the task transcript in /data/state.json.
// New contexts share workspace files, not model history. Deletion removes registry/transcript access, not SDK files or historical backups.
export function initSessions(state) {
  if (!Array.isArray(state.sessions)) {
    const id = state.sessionId || 'primary';
    state.sessions = [{ id, title: state.sessionId ? '原有会话' : '新会话', createdAt: Date.now(), initialized: !!state.sessionId }];
    state.sessionId = id;
    for (const task of state.history || []) task.sessionId ||= id;
    if (state.task) state.task.sessionId ||= id;
  }
  if (!state.sessions.some(s => s.id === state.sessionId)) throw Error('当前会话记录缺失；拒绝创建替代上下文');
}
export function sessionView(state) {
  return { sessionId: state.sessionId, sessions: state.sessions.map(({id,title,createdAt}) => ({id,title,createdAt})), sessionsSupported: true, sessionDeletionSupported: true };
}
export function selectSession(state, body) {
  if (!body || !['create','select','delete'].includes(body.action) || typeof body.id !== 'string') throw Error('无效会话操作');
  state.deletedSessionIds ||= [];
  if(body.action==='delete') {
    if(state.deletedSessionIds.includes(body.id))return sessionView(state);
    if(!state.sessions.some(s=>s.id===body.id))throw Error('会话不存在');
    state.sessions=state.sessions.filter(s=>s.id!==body.id);
    state.history=(state.history||[]).filter(t=>t.sessionId!==body.id);
    state.deletedSessionIds.push(body.id);
    if(state.sessionId===body.id){
      if(!state.sessions.length)state.sessions.push({id:crypto.randomUUID(),title:'新会话',createdAt:Date.now(),initialized:false});
      state.sessionId=state.sessions.at(-1).id;
      state.task=state.history.findLast(t=>t.sessionId===state.sessionId)||null;
    }
    return sessionView(state);
  }
  if(state.deletedSessionIds.includes(body.id))throw Error('会话已删除，不能重新选择或创建同一标识');
  let item = state.sessions.find(s => s.id === body.id);
  if (body.action === 'create') {
    if (!/^[a-f0-9-]{36}$/.test(body.id)) throw Error('无效新会话标识');
    if (item) return sessionView(state); // Idempotent retry never creates another session.
    item = { id: body.id, title: '新会话', createdAt: Date.now(), initialized: false };
    state.sessions.push(item);
  } else if (!item) throw Error('会话不存在；不会创建替代会话');
  state.sessionId = item.id;
  state.task = (state.history || []).findLast(t => t.sessionId === item.id) || null;
  return sessionView(state);
}
