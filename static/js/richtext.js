(() => {
  if (window.RichText) return;

  // Minimal, dependency-free markdown-ish renderer used by diary and todos.
  const markdownPatterns = {
    blockquote: /^&gt;\s+(.+)$/gm,
    headers: /^#{1,6}\s+(.+)$/gm,
    bold: /(?<!\w)(\*\*|__)(?=\S)(.+?[*_]*)(?<=\S)\1(?!\w)/g,
    italic: /(?<!\w)(\*|_)(?=\S)(.+?)(?<=\S)\1(?!\w)/g,
    codeBlock: /```([\s\S]*?)```/gm,
    inlineCode: /`([^`]+)`/g,
    image: /!\[([^\]]*)\]\(((https?:\/\/[^\s)]+)(?:\s+"([^\"]*)")?)\)/g,
    link: /\[([^\]]+)\]\(((https?:\/\/[^\s)]+)(?:\s+"([^\"]*)")?)\)/g,
    hr: /^[-*_]{3,}$/gm,
    unorderedList: /^(\s*)[-*+]\s+(.+)$/gm,
    orderedList: /^(\s*)\d+\.\s+(.+)$/gm
  };

  function escapeHtml(text, preserveUrls = false) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    let result = div.innerHTML;
    if (preserveUrls) result = result.replace(/%20/g, ' ');
    return result;
  }

  function autoLinkUrls(text) {
    return text.replace(/(^|\s)(https?:\/\/[^\s<]+)(?=\s|$)/g, (m, p1, url) => `${p1}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  }

  function processLists(text) {
    const listBlockRegex = /((?:^\s*[-*+]\s+.*\n?)|(?:^\s*\d+\.\s+.*\n?))+/gm;
    return text.replace(listBlockRegex, (listBlock) => {
      const lines = listBlock.trim().split('\n');
      let html = '';
      const stack = [];
      const itemRegex = /^(\s*)([-*+]|\d+\.)\s+(.*)/;
      for (const line of lines) {
        const match = line.match(itemRegex);
        if (!match) continue;
        const indent = match[1].length;
        const level = Math.floor(indent / 4);
        const type = /^\s*\d+\.\s+/.test(line) ? 'ol' : 'ul';
        const content = match[3];
        while (stack.length > 0 && level < stack.length) {
          html += `</li></${stack.pop().type}>\n`;
        }
        if (stack.length > 0 && level < stack.length) {
          html += `</li>\n`;
        }
        while (level >= stack.length) {
          html += `<${type}>`;
          stack.push({ type });
        }
        html += `<li>${content}`;
      }
      while (stack.length > 0) {
        html += `</li></${stack.pop().type}>\n`;
      }
      return html;
    });
  }

  function formatTextWithWhitespace(text) {
    return text.split('\n').map(line => {
      if (line.startsWith('<li') || line.startsWith('</ul>') || line.startsWith('</ol>')) return line;
      let processedLine = line.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
      const leadingSpacesMatch = processedLine.match(/^(\s+)/);
      if (leadingSpacesMatch) {
        const leadingSpaces = leadingSpacesMatch[1];
        const preservedSpaces = leadingSpaces.replace(/ /g, '&nbsp;');
        processedLine = preservedSpaces + processedLine.slice(leadingSpaces.length);
      }
      processedLine = processedLine.replace(/ {2,}/g, spaces => spaces.replace(/ /g, '&nbsp;'));
      return processedLine;
    }).join('\n');
  }

  function plainTextToHtml(text) {
    // input: escaped text where image markdown may already be converted to <img/> by processImages
    if (!text) return '';
    // Normalize CRLF
    let t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Split into paragraphs on two or more newlines
    const paras = t.split(/\n{2,}/g).map(p => p.replace(/^\s+|\s+$/g, '')).filter(Boolean);
    if (!paras.length) return '';
    const out = paras.map(p => {
      // Within a paragraph, preserve single newlines as <br/> so users see line breaks
      // but keep multiple consecutive spaces as non-breaking spaces
      const inner = p.replace(/\n/g, '<br/>').replace(/ {2,}/g, spaces => spaces.replace(/ /g, '&nbsp;'));
      return `<p>${inner}</p>`;
    }).join('\n');
    return out;
  }

  // Config toggles - apps can change these at runtime
  const config = {
    enableMarkdown: true,
    enableImages: true,
    enableLinks: true,
    enableLists: true,
    // Note: comments should use the application's CommentFormatter by default.
    // The renderer focuses on inline content rendering; comment parsing/quoting
    // should be handled by CommentFormatter to preserve app-specific behavior.
  };

  function renderInlineContent(raw, id, markdownEnabled = false) {
    if (!raw) return '';
    // If markdown rendering globally disabled, treat as plain text
    if (!config.enableMarkdown) markdownEnabled = false;
    if (!raw) return '';
    const group = id ? `inline-${id}` : 'inline';

    const processImages = (text) => {
      if (!config.enableImages) return text;
      return text.replace(markdownPatterns.image, (match, altText, fullUrl, cleanUrl, title) => {
        const t = cleanUrl;
        const titleAttr = title ? ` title="${escapeHtml(title, false)}"` : '';
        return `<img src='${t}' data-viewer-thumb data-viewer-group='${group}' data-viewer-src='${cleanUrl}' style='max-width:140px;max-height:140px;cursor:pointer;object-fit:cover;margin:4px;border:1px solid var(--border-color);border-radius:4px;' alt='${escapeHtml(altText, false)}'${titleAttr}/>`;
      });
      };

    if (markdownEnabled) {
      let processed = escapeHtml(raw, true);
      processed = processImages(processed);
      const codeBlocks = [];
      processed = processed.replace(markdownPatterns.codeBlock, (m, code) => { codeBlocks.push(code); return `:::CODEBLOCK${codeBlocks.length - 1}:::`; });
  if (config.enableLinks) processed = autoLinkUrls(processed);
  if (config.enableLists) processed = processLists(processed);
  processed = processed.replace(markdownPatterns.blockquote, '<blockquote>$1</blockquote>')
        .replace(markdownPatterns.headers, (match, text) => { const level = match.match(/^#+/)[0].length; return `<h${Math.min(level+2,6)}>${text}</h${Math.min(level+2,6)}>`; })
        .replace(markdownPatterns.hr, '<hr/>')
        .replace(markdownPatterns.bold, '<strong>$2</strong>')
        .replace(markdownPatterns.italic, '<em>$2</em>')
        .replace(markdownPatterns.inlineCode, '<code>$1</code>')
        .replace(markdownPatterns.link, (m, text, fullUrl, cleanUrl, title) => { const titleAttr = title ? ` title="${escapeHtml(title, false)}"` : ''; return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`; });
      processed = processed.replace(/:::CODEBLOCK(\d+):::/g, (m, index) => `<pre><code>${escapeHtml(codeBlocks[parseInt(index)], false)}</code></pre>`);
      const blockTags = ['h3','h4','h5','h6','hr','blockquote','pre','ul','ol'];
      blockTags.forEach(tag => {
        const reBefore = new RegExp(`\\n+\\s*(<${tag}[^>]*>)`, 'g');
        processed = processed.replace(reBefore, '$1');
        const reAfter = new RegExp(`(<\\/${tag}>)\\s*\\n+`, 'g');
        processed = processed.replace(reAfter, '$1');
      });
      return formatTextWithWhitespace(processed);
    }

    const withPreservedImgs = escapeHtml(raw, true);
    const withImgs = processImages(withPreservedImgs);
    // For non-markdown (plain text) mode prefer paragraph-based rendering to avoid excessive <br/>
    return plainTextToHtml(withImgs);
  }

  window.RichText = {
    renderInlineContent,
    escapeHtml,
    autoLinkUrls,
    processLists,
    formatTextWithWhitespace
  };
  // expose config for runtime toggles
  window.RichText.config = config;
})();
