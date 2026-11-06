import React from 'react';
import Icon from './Icon';

function Inline({ text }) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  const chunks = text.split(pattern).filter(Boolean);
  return chunks.map((chunk, index) => {
    if (chunk.startsWith('**') && chunk.endsWith('**')) return <strong key={index}>{chunk.slice(2, -2)}</strong>;
    if (chunk.startsWith('`') && chunk.endsWith('`')) return <code className="inline-code" key={index}>{chunk.slice(1, -1)}</code>;
    if (chunk.startsWith('*') && chunk.endsWith('*')) return <em key={index}>{chunk.slice(1, -1)}</em>;
    const link = chunk.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      let safe = '#';
      try { const parsed = new URL(link[2], window.location.origin); if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) safe = parsed.href; } catch { /* lien ignoré */ }
      return <a key={index} href={safe} target="_blank" rel="noreferrer">{link[1]}</a>;
    }
    return <React.Fragment key={index}>{chunk}</React.Fragment>;
  });
}

function CodeBlock({ code, language }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  }
  return (
    <div className="code-block">
      <div className="code-header"><span>{language || 'Code'}</span><button onClick={copy} className="code-copy"><Icon name={copied ? 'check' : 'copy'} size={14}/>{copied ? 'Copié' : 'Copier'}</button></div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export default function Markdown({ content = '' }) {
  const lines = String(content).replace(/\r/g, '').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = [];
  let code = [];
  let codeLanguage = '';
  let inCode = false;
  const flushParagraph = () => { if (paragraph.length) { blocks.push({ type: 'p', text: paragraph.join(' ') }); paragraph = []; } };
  const flushList = () => { if (list.length) { blocks.push({ type: 'list', items: [...list] }); list = []; } };

  lines.forEach((line) => {
    const fence = line.match(/^```\s*([\w#+.-]*)\s*$/);
    if (fence) {
      if (!inCode) { flushParagraph(); flushList(); inCode = true; codeLanguage = fence[1]; code = []; }
      else { blocks.push({ type: 'code', code: code.join('\n'), language: codeLanguage }); inCode = false; }
      return;
    }
    if (inCode) { code.push(line); return; }
    if (!line.trim()) { flushParagraph(); flushList(); return; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); return; }
    if (/^\s*[-*+]\s+/.test(line)) { flushParagraph(); list.push(line.replace(/^\s*[-*+]\s+/, '')); return; }
    if (/^\s*\d+[.)]\s+/.test(line)) { flushParagraph(); list.push(line.replace(/^\s*\d+[.)]\s+/, '')); return; }
    if (line.startsWith('> ')) { flushParagraph(); flushList(); blocks.push({ type: 'quote', text: line.slice(2) }); return; }
    if (/^[-*_]{3,}$/.test(line.trim())) { flushParagraph(); flushList(); blocks.push({ type: 'hr' }); return; }
    flushList(); paragraph.push(line.trim());
  });
  flushParagraph(); flushList();
  if (inCode) blocks.push({ type: 'code', code: code.join('\n'), language: codeLanguage });

  return <div className="markdown-body">{blocks.map((block, index) => {
    if (block.type === 'p') return <p key={index}><Inline text={block.text}/></p>;
    if (block.type === 'heading') return React.createElement(`h${block.level + 1}`, { key: index }, <Inline text={block.text}/>);
    if (block.type === 'list') return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline text={item}/></li>)}</ul>;
    if (block.type === 'quote') return <blockquote key={index}><Inline text={block.text}/></blockquote>;
    if (block.type === 'code') return <CodeBlock key={index} code={block.code} language={block.language}/>;
    return <hr key={index}/>;
  })}</div>;
}
