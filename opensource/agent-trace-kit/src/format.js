/** Suppress terminal control/escape/bidi sequences, never claim to redact secrets. */
export function terminalText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function formatText(report) {
  const counts = report.counts;
  const lines = ['Agent Trace Kit',
    `Events: ${counts.accepted} accepted; ${counts.duplicates} duplicate copies; ${counts.invalid} invalid; ${counts.conflictingIdentities} conflicting identities.`,
    ...(report.filtered ? ['Filtered view: only selected events are summarized; omitted events are not evidence of absence.'] : [])];
  for (const run of report.runs) {
    const agentsById = new Map(run.agents.map(agent => [agent.id, agent]));
    lines.push('', `Run ${terminalText(run.scope.runId ?? '(unknown)')} | session ${terminalText(run.scope.sessionId ?? '(unknown)')} | ${run.outcome.status}`,
      `  Recorded run cost: ${run.recordedRunCost === null ? 'unknown' : run.recordedRunCost} (not a billing total)`,
      `  Stages: ${run.stages.map(stage => `${stage.stage} (${stage.eventIds.length})`).join(' -> ') || 'none'}`);
    for (const agent of run.agents) lines.push(`  Agent ${terminalText(agent.name)} | task ${terminalText(agent.taskId ?? '(unknown)')} | ${agent.outcome.status}`);
    for (const edge of run.edges.filter(edge => edge.kind === 'parent')) {
      const from = agentsById.get(edge.from), to = agentsById.get(edge.to);
      lines.push(`    Parent: ${terminalText(from.agentId)}[${terminalText(from.taskId ?? '?')}] -> ${terminalText(to.agentId)}[${terminalText(to.taskId ?? '?')}]`);
    }
    for (const tool of run.tools) lines.push(`  Tool ${terminalText(tool.toolName ?? '(unknown)')} | task ${terminalText(tool.taskId ?? '?')} | call ${terminalText(tool.callId ?? '(legacy)')} | ${tool.state}`
      + ` | ${tool.correlation} | ${tool.durationMs === null ? 'duration unknown' : tool.durationMs + ' ms'} | outcome ${tool.resultOutcome}`);
    for (const event of run.governance) lines.push(`  Governance: ${event.result} | ${terminalText(event.summary)}`);
  }
  if (report.issues.length) {
    lines.push('', `Diagnostics: ${report.issues.length}`);
    for (const item of report.issues.slice(0, 50)) lines.push(`  ${item.severity} ${terminalText(item.code)}${item.line ? ` at line ${item.line}` : ''}: ${terminalText(item.message)}`);
    if (report.issues.length > 50) lines.push('  Additional diagnostics omitted from text; use --json for the full list.');
  }
  lines.push('', report.note);
  return lines.join('\n') + '\n';
}
