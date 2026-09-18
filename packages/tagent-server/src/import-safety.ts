export interface ImportRisk {
  level: 'low' | 'medium' | 'high';
  flags: string[];
  commands: string[];
  envVars: string[];
}

export interface ImportPreviewSafetyInput {
  writesOnConfirm: string[];
  commands: string[];
  envVars: string[];
  externalSource: string;
  message: string;
  transport?: string;
}

export interface ImportPreviewSafety {
  requiresConfirmation: true;
  willWrite: false;
  willExecute: false;
  executionPlan: {
    writesOnConfirm: string[];
    commands: string[];
    envVars: string[];
    externalSource: string;
    transport?: string;
  };
  confirmation: {
    required: true;
    message: string;
  };
}

export function scanImportRisk(content: string, source: string, commandPreview?: string): ImportRisk {
  const flags = new Set<string>();
  const commands = new Set<string>();
  const envVars = new Set<string>();
  const lower = content.toLowerCase();
  const commandText = [content, commandPreview || ''].join('\n');

  const commandPattern = /\b(npx|npm|pnpm|yarn|uvx|python|python3|pip|node|docker|bash|sh|curl|wget|powershell|cmd\.exe)\b[^\n\r`]*/gi;
  for (const match of commandText.matchAll(commandPattern)) {
    commands.add(match[0].trim().slice(0, 180));
  }

  const envPattern = /\b[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_BASE_URL|_ENDPOINT)\b/g;
  for (const match of commandText.matchAll(envPattern)) {
    const value = match[0];
    envVars.add(value);
  }
  const explicitEnvPatterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
    /\b(?:os\.(?:getenv|environ\.get)|getenv)\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    /\$\{([A-Z][A-Z0-9_]*)\}|\$env:([A-Z][A-Z0-9_]*)\b/g,
    /^\s*(?:export\s+|set\s+)([A-Z][A-Z0-9_]*)=/gm,
  ];
  for (const pattern of explicitEnvPatterns) for (const match of commandText.matchAll(pattern)) envVars.add(match[1] || match[2]);

  if (/curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash)/i.test(commandText)) flags.add('包含远程脚本管道执行');
  if (/\brm\s+-rf\b|\bdel\s+\/[sq]\b|\brmdir\s+\/s\b/i.test(commandText)) flags.add('包含删除或破坏性命令');
  if (/\bsudo\b|\bchmod\s+\+x\b/i.test(commandText)) flags.add('包含提权或可执行权限修改');
  if (commands.size > 0) flags.add('包含可能执行的命令');
  if (envVars.size > 0) flags.add('提到了环境变量或密钥配置');
  if (/github\.com|raw\.githubusercontent\.com|npmjs\.com/i.test(source)) flags.add('外部代码来源');
  if (lower.includes('postinstall') || lower.includes('preinstall')) flags.add('可能包含安装生命周期脚本');

  const level = flags.has('包含远程脚本管道执行') || flags.has('包含删除或破坏性命令')
    ? 'high'
    : commands.size > 0 || envVars.size > 0
      ? 'medium'
      : 'low';

  return {
    level,
    flags: Array.from(flags),
    commands: Array.from(commands),
    envVars: Array.from(envVars),
  };
}

export function createImportPreviewSafety(input: ImportPreviewSafetyInput): ImportPreviewSafety {
  return {
    requiresConfirmation: true,
    willWrite: false,
    willExecute: false,
    executionPlan: {
      writesOnConfirm: input.writesOnConfirm,
      commands: input.commands,
      envVars: input.envVars,
      externalSource: input.externalSource,
      ...(input.transport ? { transport: input.transport } : {}),
    },
    confirmation: {
      required: true,
      message: input.message,
    },
  };
}
