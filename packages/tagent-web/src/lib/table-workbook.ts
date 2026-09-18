import type { CellObject, Row, Sheet } from 'write-excel-file/universal';
import { metricLabels, operationLabels, parseTableReceipt } from '../components/TableCalculations.logic';

export interface TableExportContext {
  eventId: string;
  runId?: string;
  agentId?: string;
  taskId?: string;
  persisted?: boolean;
  running?: boolean;
}

type WorkbookSheet = Sheet<Blob>;
const headerColor = '#175950';
const cautionColor = '#9D3F1C';

function text(value: string): CellObject {
  // Reject unsupported XML characters instead of silently changing source labels.
  if (value.length > 32000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\uD800-\uDFFF]/u.test(value)) {
    throw new Error('记录包含 Excel 无法完整保存的字符或超长文本，未生成文件。');
  }
  return { value, type: String, format: '@', wrap: true, alignVertical: 'top' };
}

function numeric(value: number): CellObject {
  return { value, type: Number, format: '0', alignVertical: 'top' };
}

// Excel supports 15 significant decimal digits. Values outside that envelope stay text.
export function workbookNumber(value: string | null): CellObject {
  if (value === null) return { ...text('未计算'), textColor: cautionColor };
  if (!/^-?\d+(?:\.\d+)?$/.test(value) || value.length > 170) throw new Error('计算结果不是有效十进制数，未生成文件。');
  const significant = value.replace(/[-.]/g, '').replace(/^0+/, '');
  const number = Number(value);
  if (significant.length <= 15 && Number.isFinite(number) && String(number) === value) {
    const decimals = value.split('.')[1]?.length || 0;
    return { value: number, type: Number, format: decimals ? `0.${'0'.repeat(decimals)}` : '0', alignVertical: 'top' };
  }
  return text(value);
}

function sheet(name: string, headers: string[], rows: Row[], widths: number[]): WorkbookSheet {
  return { sheet: name, showGridLines: false, stickyRowsCount: 1, columns: widths.map(width => ({ width })),
    data: [headers.map(value => ({ ...text(value), fontWeight: 'bold', textColor: '#FFFFFF', backgroundColor: headerColor, height: 32 } as CellObject)),
      ...rows.map((row, index) => row.map(cell => ({ ...(cell as CellObject), backgroundColor: index % 2 ? '#F0F5F4' : '#FFFFFF', bottomBorderColor: '#D9E4E1', bottomBorderStyle: 'hair' } as CellObject)))] };
}

export function tableWorkbook(value: unknown, context: TableExportContext): { fileName: string; sheets: WorkbookSheet[] } {
  const receipt = parseTableReceipt(value);
  if (!receipt || new TextEncoder().encode(JSON.stringify(receipt)).length > 48 * 1024) throw new Error('计算记录不完整、版本不支持或超过导出上限，未生成文件。');
  const p = receipt.provenance;
  const sheets: WorkbookSheet[] = [];
  let protectedValues = 0;
  const result = (value: string | null) => {
    const cell = workbookNumber(value);
    if (value !== null && cell.type === String) protectedValues++;
    return cell;
  };
  if (receipt.action === 'aggregate') {
    const groupHeaders = receipt.groupBy.length ? receipt.groupBy.map(name => `分组：${name}`) : ['范围'];
    const groupCells = (key: string[]) => key.length ? key.map(text) : [text('全部选中数据')];
    const groupWidths = groupHeaders.map(() => 24);
    sheets.push(sheet('统计结果', [...groupHeaders, '行数', '指标', '统计方式', '结果', '结果状态', '有效数', '空白数', '无效数', '结果单元格类型'],
      receipt.groups.flatMap(group => group.metrics.map(metric => {
        const cell = result(metric.value);
        return [...groupCells(group.key), numeric(group.rows), text(metric.column), text(operationLabels[metric.operation]), cell,
          { ...text(metricLabels[metric.status]), ...(metric.status !== 'computed' ? { textColor: cautionColor } : {}) },
          numeric(metric.valid), numeric(metric.missing), numeric(metric.invalid),
          text(metric.value === null ? '未计算' : cell.type === Number ? '数值' : '文本（保留精度）')];
      })), [...groupWidths, 10, 22, 14, 26, 24, 10, 10, 10, 24]));
    const c = receipt.comparison;
    if (c) {
      const status = c.status === 'computed' ? '已计算' : c.status === 'unavailable' ? '缺少可计算结果' : '零或负基期，不适用普通增长率';
      sheets.push(sheet('基期与本期', ['指标', '统计方式', ...receipt.groupBy.map(name => `基期：${name}`), ...receipt.groupBy.map(name => `本期：${name}`),
        '变化量', '变化率（%）', '比较状态', '数据范围'], [[text(receipt.metrics[c.metric].column), text(operationLabels[receipt.metrics[c.metric].operation]),
        ...c.baseline.map(text), ...c.current.map(text), result(c.difference), result(c.percentChange), text(status), text(c.partial ? '含缺失或无效数据，非完整口径' : '按本次所选指标比较')]],
      [22, 14, ...groupWidths, ...groupWidths, 26, 26, 32, 36]));
    }
    const examples = receipt.groups.flatMap(group => group.metrics.flatMap(metric => metric.invalidExamples.map(example =>
      [...groupCells(group.key), text(metric.column), text(operationLabels[metric.operation]), numeric(example.record), text(example.value)])));
    if (examples.length) sheets.push(sheet('异常样本', [...groupHeaders, '指标', '统计方式', '原始数据记录号', '异常文本'], examples, [...groupWidths, 22, 14, 20, 50]));
  } else {
    sheets.push(sheet('字段检查', ['字段', '数值数', '其他文本数', '空白数'], receipt.profile.map(column =>
      [text(column.column), numeric(column.numeric), numeric(column.nonNumeric), numeric(column.missing)]), [32, 16, 16, 16]));
    sheets.push(sheet('前5条样本', ['记录号', ...p.columns], receipt.sample.map(row => [numeric(row.record), ...row.values.map(text)]), [12, ...p.columns.map(() => 24)]));
  }
  const detail: [string, string][] = [
    ['范围', '只包含本条实际计算回执的全部结果与口径，不包含完整对话、原始数据文件或模型报告。'],
    ['边界', '工具完成不证明数据来源真实、选区完整、业务解释合理或最终报告正确。'],
    ['运行状态', context.running ? '任务尚在运行，这是已完成工具调用的快照，不是最终交付。' : '单次工具计算记录，不据此判定整个任务成功。'],
    ['保存状态', context.persisted === false ? '记录尚未确认保存；下载不代表后端保存成功。' : context.persisted === true ? '来源记录已保存。' : '来源保存状态未在本入口核实。'],
    ['来源', p.sourceId === 'current' ? '本次用户消息' : '完整历史用户消息'], ['来源编号', p.sourceId],
    ['原文行范围（含表头）', `${p.startLine} - ${p.endLine}`], ['数据行数', String(p.rows)], ['格式', p.format.toUpperCase()],
    ['原文 SHA-256', p.sourceSha256], ['选区 SHA-256', p.selectionSha256],
    ['指纹说明', '记录计算时的材料指纹；文件未附原文，不代表已在此文件中核对原文。'],
    ['工具', 'analyze_table'], ['回执版本', String(receipt.version)],
    ['数值', '按原表单位计算，不换算单位。结果可无损往返且不超过15位有效数字时写为Excel数值，否则按文本保留，不截断精度。'],
    ['精度保护', `${protectedValues} 个结果单元格按文本保存。`],
    ['舍入', '均值和变化率最多8位小数，HALF_UP；其余统计在工具边界内精确。'],
    ['缺失', '空白不计为零，全部缺失的数值列不产生零合计。非空计数包含文本。'],
    ['文本', '分组、列名、样本等保持文本类型，不执行公式，不附宏或外部数据链接。'],
    ['样本范围', '字段样本仅前5条，异常样本每组每指标最多5条，每项最多160字符；记录号不含表头，不是原文件物理行号。'],
    ['工具边界', '本地只读表格计算，不能替代工具审批、原始数据核验或独立业务验收。'],
  ];
  if (receipt.action === 'aggregate') {
    detail.push(['无效数值策略', receipt.invalidValues === 'exclude' ? '显式排除无效数值，局部结果不等于全部原始数据。' : '含无效数值时不计算该指标。'],
      ['分组总数', String(receipt.groups.length)], ['分组说明', '分组列分别保存，空白分组仍为空白；不拼接、重排或合并分组名称。']);
    if (receipt.comparison) detail.push(['比较规则', receipt.comparison.formula], ['变化率单位', '百分比数值，例如100表示100%，不是比值1；基期非正时不提供普通增长率。']);
  }
  for (const [label, entry] of [['事件编号', context.eventId], ['任务运行编号', context.runId], ['协作者', context.agentId], ['子任务编号', context.taskId]]) {
    if (entry !== undefined) {
      if (typeof entry !== 'string' || entry.length > 500) throw new Error('计算记录标识无效，未生成文件。');
      detail.push([label!, entry]);
    }
  }
  sheets.push(sheet('计算说明', ['项目', '内容'], detail.map(([label, value]) => [text(label), text(value)]), [26, 96]));
  return { fileName: `tagent-${receipt.action === 'aggregate' ? '统计结果' : '字段检查'}-${p.selectionSha256.slice(0, 12)}.xlsx`, sheets };
}

export async function encodeTableWorkbook(value: unknown, context: TableExportContext): Promise<{ fileName: string; blob: Blob }> {
  const workbook = tableWorkbook(value, context);
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  const blob = await writeExcelFile(workbook.sheets, { fontFamily: 'Calibri', fontSize: 11 }).toBlob();
  return { fileName: workbook.fileName, blob };
}
