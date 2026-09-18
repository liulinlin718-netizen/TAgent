'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { TableAnalysisReceipt } from '@tagent/core';
import type { TableExportContext } from '../lib/table-workbook';
import styles from './TableCalculations.module.css';

export default function TableExport({ receipt, context }: { receipt: TableAnalysisReceipt; context: TableExportContext }) {
  const generation = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => () => { generation.current++; }, []);
  const download = async () => {
    const request = ++generation.current;
    setPending(true); setError(''); setSent(false);
    try {
      const { encodeTableWorkbook } = await import('../lib/table-workbook');
      if (generation.current !== request) return;
      const file = await encodeTableWorkbook(receipt, context);
      if (generation.current !== request) return;
      const url = URL.createObjectURL(file.blob), link = document.createElement('a');
      try {
        link.href = url; link.download = file.fileName;
        document.body.appendChild(link); link.click(); setSent(true);
      } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } catch (reason) {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : 'Excel 文件未能生成，请重试。');
    } finally { if (generation.current === request) setPending(false); }
  };
  return <div className={styles.export}>
    <button type="button" onClick={() => void download()} disabled={pending} title="下载本条计算的全部结果与口径，不含原始聊天内容">
      {pending ? <LoaderCircle size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}下载 Excel
    </button>
    {pending && <span className={styles.note} role="status">正在生成文件</span>}
    {sent && <span className={styles.note} role="status">已交给浏览器下载</span>}
    {error && <p className={styles.warning} role="alert">{error}</p>}
  </div>;
}
