// Packets are selected by the authenticated, project-scoped repository before
// entering this pure insertion boundary. No process-local delivery state exists.
export function injectHandoffPackets(body, packets = []) {
  if (!body || typeof body !== 'object' || !packets.length) return { body, injected: false, applied: [] };
  const applied = [];
  for (const packet of packets.slice(0, 1)) {
    if (!packet?.summary || !packet.id) continue;
    const marker = `[Operator-approved handoff ${packet.id}]`;
    const note = `${marker}\n${packet.summary}\n[End handoff]\n\n`;
    const alreadyPresent = text => {
      if (typeof text !== 'string' || !text.startsWith(marker)) return false;
      if (!text.startsWith(note)) throw Object.assign(new Error('Handoff content conflicts with the approved packet'), { code: 'protected_content_changed' });
      return true;
    };
    const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : null;
    const message = messages?.find(item => item?.role === 'user');
    if (message && typeof message.content === 'string') {
      if (!alreadyPresent(message.content)) message.content = note + message.content;
      applied.push({ id: packet.id });
    } else if (message && Array.isArray(message.content)) {
      if (!message.content.some(block => alreadyPresent(block?.text))) {
        const firstNonResult = message.content.findIndex(block => block?.type !== 'tool_result');
        message.content.splice(firstNonResult < 0 ? message.content.length : firstNonResult, 0, { type: messages === body.input ? 'input_text' : 'text', text: note });
      }
      applied.push({ id: packet.id });
    } else if (typeof body.input === 'string') {
      if (!alreadyPresent(body.input)) body.input = note + body.input;
      applied.push({ id: packet.id });
    } else if (Array.isArray(body.contents)) {
      const user = body.contents.find(item => item?.role === 'user' && Array.isArray(item.parts));
      if (!user) continue;
      if (!user.parts.some(part => alreadyPresent(part?.text))) {
        const firstNonResult = user.parts.findIndex(part => !part?.functionResponse);
        user.parts.splice(firstNonResult < 0 ? user.parts.length : firstNonResult, 0, { text: note });
      }
      applied.push({ id: packet.id });
    }
  }
  return { body, injected: applied.length > 0, applied };
}
