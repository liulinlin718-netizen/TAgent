'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Blockquote, Nodes, Root, RootContent } from 'mdast';
import { AlertTriangle, CheckCircle2, Code2, Info, Link as LinkIcon, Quote, Sparkles } from 'lucide-react';
import styles from './Markdown.module.css';

const ADMONITIONS: Record<string, { label: string; icon: React.ElementType }> = {
  note: { label: 'Note', icon: Info }, info: { label: 'Info', icon: Info }, tip: { label: 'Tip', icon: Sparkles },
  success: { label: 'Success', icon: CheckCircle2 }, important: { label: 'Important', icon: Sparkles },
  warning: { label: 'Warning', icon: AlertTriangle }, caution: { label: 'Caution', icon: AlertTriangle }, danger: { label: 'Danger', icon: AlertTriangle },
};

// Keep the report layout while leaving Markdown parsing, references and lists to remark.
function reportStructure() {
  return (tree: Root) => {
    function visit(node: Nodes) {
      if (node.type === 'blockquote') {
        const first = node.children[0], text = first?.type === 'paragraph' ? first.children[0] : undefined;
        const marker = text?.type === 'text' ? text.value.match(/^\[!(\w+)\][ \t]*([^\n]*)\n?/) : undefined;
        if (marker && text?.type === 'text') {
          const kind = marker[1].toLowerCase();
          node.data = { hProperties: { 'data-admonition': kind, 'data-title': marker[2] || ADMONITIONS[kind]?.label || marker[1] } };
          text.value = text.value.slice(marker[0].length);
        }
      }
      if (node.type === 'table') {
        const count = Math.max(...node.children.map(row => row.children.length));
        for (const row of node.children) while (row.children.length < count) row.children.push({ type: 'tableCell', children: [] });
        if (node.align) while (node.align.length < count) node.align.push(null);
      }
      if ('children' in node) node.children.forEach(visit);
    }
    tree.children.forEach(visit);
    const wrap = (tag: string, className: string, children: RootContent[]): Blockquote => ({ type: 'blockquote',
      data: { hName: tag, hProperties: { className } }, children: children as Blockquote['children'] });
    const result: RootContent[] = [];
    let remaining = tree.children;
    if (remaining[0]?.type === 'heading' && remaining[0].depth === 1) {
      result.push(wrap('header', styles.hero, [remaining[0]])); remaining = remaining.slice(1);
    }
    let section: RootContent[] = [];
    const commit = () => {
      if (!section.length) return;
      const heading = section[0];
      if (heading.type !== 'heading' || heading.depth !== 2) result.push(wrap('section', styles.intro, section));
      else result.push(wrap('section', styles.section, [
        ...(result.length ? [{ type: 'thematicBreak' as const, data: { hName: 'div', hProperties: { className: styles.sectionDivider } } }] : []),
        wrap('div', styles.sectionHeading, [heading]), wrap('div', styles.sectionContent, section.slice(1)),
      ]));
      section = [];
    };
    for (const node of remaining) {
      if (node.type === 'heading' && node.depth === 2) commit();
      section.push(node);
    }
    commit(); tree.children = result;
  };
}

export default function Markdown({ content }: { content: string }) {
  const id = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const prefix = 'report-' + id + '-';
  if (!content.trim()) return null;
  return <article className={styles.document}>
    <ReactMarkdown remarkPlugins={[remarkGfm, reportStructure]} remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: '来源注释' }} skipHtml components={{
      h1: ({ children }) => <h1>{children}</h1>,
      h2: ({ children, id }) => <h2 id={id === 'footnote-label' ? prefix + 'label' : id} className={styles.sectionTitle}>{children}</h2>,
      h3: ({ children }) => <h3 className={styles.subheading}>{children}</h3>,
      h4: ({ children }) => <h4 className={styles.subheading}>{children}</h4>,
      h5: ({ children }) => <h5 className={styles.subheading}>{children}</h5>,
      h6: ({ children }) => <h6 className={styles.subheading}>{children}</h6>,
      p: ({ children }) => <p className={styles.paragraph}>{children}</p>,
      ul: ({ children }) => <ul className={styles.bulletList}>{children}</ul>,
      ol: ({ children, start }) => <ol className={styles.stepList} start={start}>{children}</ol>,
      code: ({ children, className }) => <code className={styles.inlineCode + ' ' + (className || '')}>{children}</code>,
      pre: ({ children, node }) => {
        const child = node?.children[0];
        const names = child?.type === 'element' ? child.properties.className : undefined;
        const language = Array.isArray(names) ? names.find(name => String(name).startsWith('language-')) : undefined;
        return <div className={styles.codeBlock}><div className={styles.codeHeader}><Code2 size={15} aria-hidden /><span>{language ? String(language).slice(9) : 'code'}</span></div><pre>{children}</pre></div>;
      },
      table: ({ children }) => <div className={styles.tableWrap} role="region" aria-label="报告表格" tabIndex={0}><table>{children}</table></div>,
      blockquote: ({ children, node }) => {
        const kind = String(node?.properties['data-admonition'] || '');
        if (!kind) return <blockquote className={styles.quote}><Quote size={18} aria-hidden /><div>{children}</div></blockquote>;
        const config = ADMONITIONS[kind] || ADMONITIONS.note, Icon = config.icon;
        return <div className={styles.admonition + ' ' + (styles['admonition-' + kind] || styles['admonition-note'])}>
          <div className={styles.admonitionTitle}><Icon size={16} aria-hidden /><span>{String(node?.properties['data-title'] || config.label)}</span></div>
          <div className={styles.admonitionBody}>{children}</div>
        </div>;
      },
      hr: () => <hr className={styles.hr} />,
      img: ({ alt }) => <span>{alt}</span>,
      a: ({ href, children, id }) => href ? <a id={id} className={styles.link} href={href}
        aria-describedby={href.startsWith('#' + prefix + 'fn-') ? prefix + 'label' : undefined}
        {...(!href.startsWith('#') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {!href.startsWith('#') && <LinkIcon size={13} aria-hidden />}{children}</a> : <span>{children}</span>,
    }}>{content}</ReactMarkdown>
  </article>;
}
