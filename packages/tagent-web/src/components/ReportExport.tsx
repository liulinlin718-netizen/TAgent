'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { ChatMessage } from '../lib/conversations';
import { canExportReport, reportExportInput } from '../lib/report-export';
import styles from './ReportExport.module.css';

export default function ReportExport({ message }: { message: ChatMessage }) {
  const generation = useRef(0);
  const [state, setState] = useState<{ message: ChatMessage; pending?: boolean; error?: string; notice?: string }>();
  const { pending, error, notice } = state?.message === message ? state : {};
  useEffect(() => () => { generation.current++; }, [message]);
  const download = async () => {
    if (pending) return;
    const request = ++generation.current;
    setState({ message, pending: true });
    try {
      const input = reportExportInput(message);
      const { encodeReportDocument } = await import('../lib/report-document');
      if (generation.current !== request) return;
      const result = await encodeReportDocument(input);
      if (generation.current !== request) return;
      const url = URL.createObjectURL(result.blob), anchor = document.createElement('a');
      try {
        anchor.href = url; anchor.download = result.fileName;
        document.body.appendChild(anchor); anchor.click();
        setState({ message, notice: ['已交给浏览器下载', ...result.warnings].join('；') });
      } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } catch (reason) {
      if (generation.current === request) setState({ message, error: reason instanceof Error ? reason.message : 'Word 文件未能生成，请重试。' });
    }
  };
  if (!canExportReport(message)) return null;
  return <div className={styles.root} data-testid="report-export">
    <button type="button" onClick={() => void download()} disabled={pending} title="下载本条回复和核对摘要；不包含其他对话，不重新调用模型">
      {pending ? <LoaderCircle size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}下载 Word
    </button>
    {pending && <span role="status">正在生成文件</span>}
    {notice && <span role="status">{notice}</span>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
