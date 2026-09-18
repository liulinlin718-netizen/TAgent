export const OFFICE_ANSWERS = [
  { currentIds: ['release'], backgroundIds: ['archive'], unverifiedIds: ['rumor'], participants: 42, sourceUrl: 'https://benchmark.invalid/sources' },
  { items: ['资料核对', '排期确认'], locale: 'zh-CN', count: 2 },
  { totalValue: 76, totalStock: 8, receipt: 'INV-731' },
  { tasks: [{ id: 'collect', dependsOn: [], owner: '林' }, { id: 'check', dependsOn: ['collect'], owner: '周' }, { id: 'report', dependsOn: ['check'], owner: '林' }], acceptance: '数据核对后交付报告' },
  { unit: '万元', growthRate: 0.25, knownTotal: 270, quarterTotal: null, missingMonths: ['6月'] },
  { orders: 420, externalAction: 'none', installed: false },
  { goal: '撰写试点复盘', completed: ['核对12个样本'], risks: ['样本不足'], openQuestions: ['截止日期'], nextAgent: '文档助手' },
];
export const OFFICE_ROLE_ANSWERS: Record<string, object> = {
  research: { conclusion: '只能确认试点数据', sampleSize: 12, generalizable: false, nextStep: '扩大样本' },
  document: { title: '试点复盘', sections: ['摘要', '材料', '限制', '建议'], sampleSize: 12, recommendation: '扩大样本' },
  data: { before: 120, after: 150, growthRate: 0.25, unit: '万元' },
  project: { owner: '林', blockedBy: '审批', dueDate: null, acceptance: '新增12个样本' },
  communication: { to: '林', subject: '扩样审批', body: '请确认新增12个样本的审批安排。谢谢。', sent: false },
  presentation: { titles: ['试点结果', '下一步'], sampleSize: 12, decision: '扩样审批', generalizable: false },
};
