// Structural fixture only. A passed fixture verdict is not evidence of model quality.
export function fixtureOfficeCase(messages) {
  let current = messages.findLast(message => message.role === 'user')?.content ?? '';
  try {
    const payload = JSON.parse(current);
    if (typeof payload.task === 'string') current = payload.task;
  } catch { /* Plain task input, not a structured review request. */ }
  const marker = '\n\n## 本次用户请求\n';
  if (current.includes(marker)) current = current.slice(current.lastIndexOf(marker) + marker.length);
  return current.match(/office-case-(pass|repair|failed|malformed|partial-repair|partial-still-invalid|partial|cut-revision|cut-review|export|serial-repair|serial-failed|subset-repair|serial-condition|date-comparison|absolute-pass|absolute-repair|rows-repair)/)?.[1];
}

export function fixtureOfficeReview(messages) {
  const input = JSON.parse(messages[1].content);
  return JSON.stringify({
    areas: ['instructions', 'material_consistency', 'arithmetic', 'deliverable', 'actions'].map(area =>
      ({ area, status: 'passed', reason: '本地模拟核对，仅用于协议和界面验收。' })),
    blocks: input.blocks.map(block => ({ index: block.index, verdict: 'non_factual', reason: '本地模拟段落。', evidence: [] })),
    lengthLimits: [], calculations: [],
  });
}
