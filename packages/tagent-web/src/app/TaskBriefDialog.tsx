'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, ArrowRight, ClipboardPen, X } from 'lucide-react';
import { buildTaskBrief, initialBrief, type OfficeTask, type TaskBrief } from '../lib/task-brief';
import styles from './TaskWorkbench.module.css';
import TableImport from './TableImport';

export default function TaskBriefDialog({ task, target, existingDraft, onApply, onClose, restoreFocus }: {
  task: OfficeTask; target: string; existingDraft: string;
  onApply: (prepared: string, mode: 'append' | 'replace') => void;
  onClose: () => void; restoreFocus: () => void;
}) {
  const [values, setValues] = useState<TaskBrief>(() => initialBrief(task));
  const [preview, setPreview] = useState(''), [error, setError] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const goalRef = useRef<HTMLInputElement>(null), previewRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (preview) previewRef.current?.focus(); else goalRef.current?.focus();
  }, [preview]);
  const update = (field: keyof TaskBrief, value: string) => { setValues(previous => ({ ...previous, [field]: value })); setError(''); };
  const close = () => onClose();
  return <Dialog.Root open onOpenChange={open => { if (!open) close(); }}>
    <Dialog.Portal><Dialog.Overlay className={styles.overlay} />
      <Dialog.Content className={styles.dialog} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
        <header className={styles.dialogHeader}>
          <div><Dialog.Title className={styles.dialogTitle}>{task.title}</Dialog.Title><Dialog.Description className={styles.meta}>{target} · 任务草稿</Dialog.Description></div>
          <button type="button" className={styles.iconButton} onClick={close} aria-label="关闭任务准备" title="关闭任务准备"><X size={19} /></button>
        </header>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {preview ? <>
          <div className={styles.dialogBody}>
            <h2 ref={previewRef} tabIndex={-1} className={styles.previewHeading}>任务预览</h2>
            <pre className={styles.preview}>{preview}</pre>
            {existingDraft && <fieldset className={styles.draftChoice}>
              <legend>当前已有未发送草稿</legend>
              <label><input type="radio" name="draft-mode" checked={mode === 'append'} onChange={() => setMode('append')} />保留原草稿，在末尾追加</label>
              <label><input type="radio" name="draft-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />替换原草稿</label>
              <details><summary>查看原草稿</summary><pre className={styles.preview}>{existingDraft}</pre></details>
            </fieldset>}
          </div>
          <footer className={styles.dialogFooter}>
            <button type="button" className={styles.command} onClick={() => { setPreview(''); setError(''); }}><ArrowLeft size={17} />返回修改</button>
            <button type="button" className={`${styles.command} ${styles.primary}`} title="只填入草稿，不发送任务" onClick={() => {
              try { onApply(preview, mode); } catch (cause) { setError(cause instanceof Error ? cause.message : '未填入草稿，请重新核对。'); }
            }}><ClipboardPen size={17} />填入草稿</button>
          </footer>
        </> : <form className={styles.form} onSubmit={event => {
          event.preventDefault();
          try { setPreview(buildTaskBrief(task, values)); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : '请核对任务内容。'); }
        }}>
          <div className={styles.dialogBody}>
            <label className={styles.field}>任务主题<input ref={goalRef} required maxLength={200} value={values.goal} onChange={event => update('goal', event.target.value)} placeholder={task.goalExample} /></label>
            {task.id === 'research' && <label className={styles.field}>信息时间范围<select value={values.period} onChange={event => update('period', event.target.value)}>
              <option value="recent30">近30天</option><option value="today">今天</option><option value="unspecified">不限定时间</option>
            </select></label>}
            {task.id === 'data' && <TableImport materials={values.materials} onApply={text => update('materials', text)} />}
            <label className={styles.field}>{task.materialLabel}{!task.materialRequired && '（选填）'}<textarea required={task.materialRequired} rows={5} maxLength={task.id === 'data' ? 65536 : 16000} value={values.materials} onChange={event => update('materials', event.target.value)} /></label>
            <label className={styles.field}>面向对象（选填）<input maxLength={200} value={values.audience} onChange={event => update('audience', event.target.value)} /></label>
            <label className={styles.field}>期望交付<textarea required rows={3} maxLength={1500} value={values.output} onChange={event => update('output', event.target.value)} /></label>
            <label className={styles.field}>额外要求（选填）<textarea rows={2} maxLength={2000} value={values.constraints} onChange={event => update('constraints', event.target.value)} /></label>
          </div>
          <footer className={styles.dialogFooter}><button type="button" className={styles.command} onClick={close}>取消</button><button type="submit" className={`${styles.command} ${styles.primary}`}>预览任务<ArrowRight size={17} /></button></footer>
        </form>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
