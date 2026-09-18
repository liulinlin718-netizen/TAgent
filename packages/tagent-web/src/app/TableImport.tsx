'use client';

import { useEffect, useRef, useState } from 'react';
import { FileUp, LoaderCircle, Plus, X } from 'lucide-react';
import type { TableImportPreview } from '@tagent/core';
import { API_BASE, apiFetch } from '../lib/api-client';
import { appendTableMaterial, columnLabel, selectedTable, type TableSelection } from '../lib/table-import';
import styles from './TableImport.module.css';

export default function TableImport({ materials, onApply }: { materials: string; onApply: (text: string) => void }) {
  const [file, setFile] = useState<File>(), [encoding, setEncoding] = useState('utf-8');
  const [preview, setPreview] = useState<TableImportPreview>(), [selection, setSelection] = useState<TableSelection>();
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  const reset = () => { request.current?.abort(); request.current = null; setPending(false); setError(''); setPreview(undefined); setSelection(undefined); setConfirmed(false); };
  const selectSheet = (data: TableImportPreview, sheet: number) => {
    setSelection({ sheet, startRow: 1, endRow: data.sheets[sheet].rows.length, startColumn: 1, endColumn: data.sheets[sheet].rows[0]?.length || 0 }); setConfirmed(false);
  };
  const read = async () => {
    if (!file) return;
    reset(); const controller = new AbortController(); request.current = controller; setPending(true);
    try {
      if (!/\.(xlsx|csv|tsv)$/i.test(file.name) || file.size > 2 * 1024 * 1024 || !file.size) throw new Error('请选择不超过2 MiB的.xlsx、.csv或.tsv文件。');
      const response = await apiFetch(`${API_BASE}/api/data/import/preview?name=${encodeURIComponent(file.name)}&encoding=${encoding}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '文件读取失败，请重试。');
      if (data.version !== 1 || !Array.isArray(data.sheets) || !data.sheets.length || data.willWrite !== false || data.willExecute !== false || data.requiresConfirmation !== true) throw new Error('文件预览格式无效。');
      if (request.current !== controller) return;
      setPreview(data); selectSheet(data, Math.max(0, data.sheets.findIndex((sheet: { hidden: boolean }) => !sheet.hidden)));
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '文件读取失败。');
    } finally { if (request.current === controller) setPending(false); }
  };
  let selected: ReturnType<typeof selectedTable> | undefined, selectionError = '';
  if (preview && selection) try { selected = selectedTable(preview, selection); } catch (cause) { selectionError = cause instanceof Error ? cause.message : '范围无效。'; }
  const sheet = preview && selection ? preview.sheets[selection.sheet] : undefined;
  return <section className={styles.root} aria-label="表格文件导入">
    <div className={styles.toolbar}>
      <input ref={input} className={styles.fileInput} type="file" accept=".xlsx,.csv,.tsv" aria-label="选择表格文件" onChange={event => { reset(); setFile(event.target.files?.[0]); }} />
      <button type="button" onClick={() => input.current?.click()}><FileUp size={16} />选择表格</button>
      {file && <><span className={styles.fileName}>{file.name}</span><button type="button" title="移除文件" aria-label="移除文件" onClick={() => { reset(); setFile(undefined); if (input.current) input.current.value = ''; }}><X size={16} /></button></>}
    </div>
    {file && <>
      {!/\.xlsx$/i.test(file.name) && <label className={styles.field}>文件编码<select value={encoding} onChange={event => { reset(); setEncoding(event.target.value); }}><option value="utf-8">UTF-8</option><option value="gb18030">中文 GB18030 / GBK</option><option value="utf-16le">UTF-16 LE</option></select></label>}
      <p className={styles.note}>文件将发送到TAgent后端内存读取，不落盘、不调用模型。确认的数据在发送任务时会提交给模型。</p>
      <button type="button" disabled={pending} onClick={() => void read()}>{pending ? <LoaderCircle size={16} /> : <FileUp size={16} />}{pending ? '正在读取' : '读取预览'}</button>
      {pending && <button type="button" onClick={reset}>取消读取</button>}
    </>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {preview && selection && sheet && <div>
      <label className={styles.field}>工作表<select value={selection.sheet} onChange={event => selectSheet(preview, Number(event.target.value))}>{preview.sheets.map((sheet, index) => <option key={index} value={index}>{sheet.name}{sheet.hidden ? '（隐藏）' : ''}</option>)}</select></label>
      <div className={styles.ranges}>
        {([['startRow', '表头行'], ['endRow', '末行'], ['startColumn', '首列'], ['endColumn', '末列']] as const).map(([key, label]) => <label className={styles.field} key={key}>{label}<input type="number" min="1" max={key.endsWith('Row') ? sheet.rows.length : sheet.rows[0]?.length || 0} value={selection[key] || ''} onChange={event => { setSelection({ ...selection, [key]: Number(event.target.value) }); setConfirmed(false); }} /></label>)}
      </div>
      {selectionError && <p role="status" className={styles.error}>{selectionError}</p>}
      <div className={styles.scroll} role="region" aria-label="文件数据预览" tabIndex={0}><table>
        <caption>{sheet.rows.length}行 · {sheet.rows[0]?.length || 0}列 · 从表头行起最多10行预览</caption>
        <thead><tr><th>行</th>{sheet.rows[0]?.map((_, index) => <th key={index}>{columnLabel(index + 1)}</th>)}</tr></thead>
        <tbody>{sheet.rows.slice(Math.max(0, selection.startRow - 1), Math.min(sheet.rows.length, selection.startRow + 9)).map((row, index) => <tr key={index}><th>{Math.max(1, selection.startRow) + index}</th>{row.map((cell, column) => <td key={column}>{cell.length > 120 ? <details><summary>{cell.slice(0, 60)}...</summary>{cell}</details> : cell}</td>)}</tr>)}</tbody>
      </table></div>
      <ul className={styles.notes}>{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      {selected && <>
        <p className={styles.note}>{selected.range} · {selected.rows.length - 1}条数据 · 公式{selected.formulas}处（无结果{selected.missing}处） · 错误{selected.errors}处 · 隐藏行{selected.hiddenRows} / 列{selected.hiddenColumns}</p>
        <label className={styles.confirm}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对范围、单位及已保存的公式结果</label>
        <button type="button" disabled={!confirmed} onClick={() => {
          try { onApply(appendTableMaterial(materials, selected!.text)); reset(); setFile(undefined); if (input.current) input.current.value = ''; }
          catch (cause) { setError(cause instanceof Error ? cause.message : '材料未修改。'); }
        }}><Plus size={16} />确认添加到材料</button>
      </>}
    </div>}
  </section>;
}
