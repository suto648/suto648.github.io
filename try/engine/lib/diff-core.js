// 差分の中核。
//
// ★このファイルは外部I/Oを一切しない。
//   ファイルも通信も触らず、渡された内容だけで計算する。
//   だから Node でもブラウザでもそのまま動く。
//
//   サーバ版（server.js）はファイルから読んだ内容を渡し、
//   オンライン版はブラウザに保存した内容を渡す。
//   「本日更新」と「履歴」はこの製品の差別化そのものなので、
//   同じ計算を2つ書いてずれることだけは避ける。
//
//   fs / path / __dirname をここに持ち込まないこと。
//   持ち込んだ瞬間にブラウザで動かなくなる。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DiffCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function canonicalizeRichTextForDiff(text) {
    if (typeof text !== 'string') return '';
    return text
      .replace(/(?:<br\s*\/?>\s*)+$/gi, '')
      .replace(/(?:&nbsp;|\u00a0)+$/gi, '')
      .trim();
  }

  // Ensure each snapshot line has balanced inline tags.
  // When a paragraph with <code>...<br>...</code> is split by <br>,
  // one line gets <code> without </code> and vice versa.
  // This version processes all lines sequentially, carrying open tags across lines.
  function balanceInlineTagsMultiline(lines) {
    const allowedTags = new Set(['code', 'b', 'strong']);
    let carryOver = []; // tags open from previous line

    return lines.map(line => {
      // Prepend carried-over open tags
      if (carryOver.length > 0) {
        line = carryOver.map(t => `<${t}>`).join('') + line;
      }

      // Parse tags in this line to find what's still open at end
      const tagPattern = /<(\/?)(\w+)>/g;
      const openStack = [];
      let m;
      while ((m = tagPattern.exec(line)) !== null) {
        const isClose = m[1] === '/';
        const tagName = m[2].toLowerCase();
        if (!allowedTags.has(tagName)) continue;
        if (isClose) {
          if (openStack.length > 0 && openStack[openStack.length - 1] === tagName) {
            openStack.pop();
          }
        } else {
          openStack.push(tagName);
        }
      }

      // Close unclosed tags at end of this line
      carryOver = [...openStack];
      if (openStack.length > 0) {
        line += openStack.slice().reverse().map(t => `</${t}>`).join('');
      }

      return line;
    });
  }

  // Convert JSON blocks to legacy .snapshot text format (for md-watcher compatibility)
  function blocksToSnapshot(blocks) {
    const lines = [];
    for (const b of blocks) {
      if (b.type === 'heading') {
        const text = canonicalizeRichTextForDiff(b.text || '').replace(/<[^>]+>/g, '').trim();
        // level:1 → ####  (md-watcher 4-hash style)
        // level:2 → ##### (md-watcher 5-hash style, default)
        const hashes = (b.level === 1) ? '####' : '#####';
        lines.push(hashes + ' ' + text);
        lines.push('');
      } else if (b.type === 'paragraph') {
        const raw = canonicalizeRichTextForDiff(b.text || '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/div>/gi, '\n')
          .replace(/<div[^>]*>/gi, '')
          .replace(/<(?!\/?(code|b|strong)\b)[^>]+>/g, '');
        const indent = '&#x09;'.repeat(b.indent || 0);
        const splitLines = raw.split('\n');
        const balanced = balanceInlineTagsMultiline(splitLines);
        for (const tl of balanced) {
          lines.push(tl.trim() ? indent + tl : '');
        }
        lines.push('', '');
      } else if (b.type === 'code') {
        lines.push('```' + (b.language || ''));
        // Split by newlines to match snapshot format (each line = separate entry)
        for (const cl of (b.content || '').split(/\r?\n/)) {
          lines.push(cl);
        }
        lines.push('```');
        lines.push('');
      } else if (b.type === 'table') {
        if (b.headers && b.headers.length) {
          lines.push('| ' + b.headers.join(' | ') + ' |');
          (b.rows || []).forEach(row => {
            lines.push('| ' + row.map(c => (c || '').replace(/<[^>]+>/g, '')).join(' | ') + ' |');
          });
          lines.push('');
        }
      } else if (b.type === 'image') {
        // \u753b\u50cf\u306f\u30d6\u30ed\u30c3\u30afID\u3092\u57cb\u3081\u305f\u884c\u306b\u3059\u308b\uff08\u672c\u65e5\u66f4\u65b0/\u30a8\u30af\u30b9\u30dd\u30fc\u30c8\u3067\u5b9f\u753b\u50cf\u3092\u5f15\u3051\u308b\u3088\u3046\u306b\uff09\u3002
        // ID\u7121\u3057\u306e\u65e7\u30c7\u30fc\u30bf\u306f\u5f93\u6765\u3069\u304a\u308a [\u753b\u50cf]\u3002
        lines.push(b.id ? `[\u753b\u50cf#${b.id}]` : '[\u753b\u50cf]');
        lines.push('');
      } else if (b.type === 'section') {
        if (b.size === 'small') {
          // 小セクションは「見た目だけの折りたたみ」。本日更新の差分では透過させ、
          // セクションとしてグルーピングせず子要素をそのまま展開する。
          lines.push(...blocksToSnapshot(b.children || []));
        } else {
          lines.push(`[[ ${b.title || ''} ]]`);
          lines.push(...blocksToSnapshot(b.children || []));
          lines.push('[[/]]');
          lines.push('');
        }
      }
    }
    return lines;
  }

  function flattenBlocks(blocks, parentPath) {
    const items = [];
    for (const b of blocks) {
      const p = parentPath ? `${parentPath} > ${b.title || b.text || ''}` : (b.title || b.text || '');
      if (b.type === 'section') {
        items.push({ id: b.id, type: 'section', text: b.title, path: p });
        if (b.children) {
          items.push(...flattenBlocks(b.children, b.title));
        }
      } else if (b.type === 'heading') {
        items.push({ id: b.id, type: 'heading', text: canonicalizeRichTextForDiff(b.text), path: parentPath || '' });
      } else if (b.type === 'paragraph') {
        items.push({ id: b.id, type: 'paragraph', text: canonicalizeRichTextForDiff(b.text), indent: b.indent, path: parentPath || '' });
      } else if (b.type === 'code') {
        items.push({ id: b.id, type: 'code', text: b.content, language: b.language, path: parentPath || '' });
      } else if (b.type === 'table') {
        items.push({ id: b.id, type: 'table', text: JSON.stringify(b.headers) + JSON.stringify(b.rows), path: parentPath || '' });
      }
    }
    return items;
  }

  function computeDiff(oldContent, newContent) {
    const oldItems = flattenBlocks(oldContent.blocks || [], '');
    const newItems = flattenBlocks(newContent.blocks || [], '');

    const oldMap = new Map();
    for (const item of oldItems) oldMap.set(item.id, item);

    const newMap = new Map();
    for (const item of newItems) newMap.set(item.id, item);

    const added = [];
    const modified = [];
    const removed = [];

    for (const item of newItems) {
      const old = oldMap.get(item.id);
      if (!old) {
        added.push(item);
      } else if (old.text !== item.text) {
        modified.push({ old: old, new: item });
      }
    }

    for (const item of oldItems) {
      if (!newMap.has(item.id)) {
        removed.push(item);
      }
    }

    // Group by section path
    const groups = {};
    for (const item of added) {
      const key = item.path || 'トップレベル';
      if (!groups[key]) groups[key] = { added: [], modified: [], removed: [] };
      groups[key].added.push(item);
    }
    for (const m of modified) {
      const key = m.new.path || 'トップレベル';
      if (!groups[key]) groups[key] = { added: [], modified: [], removed: [] };
      groups[key].modified.push(m);
    }
    for (const item of removed) {
      const key = item.path || 'トップレベル';
      if (!groups[key]) groups[key] = { added: [], modified: [], removed: [] };
      groups[key].removed.push(item);
    }

    return {
      totalAdded: added.length,
      totalModified: modified.length,
      totalRemoved: removed.length,
      groups
    };
  }

  function normalizeDiffWhitespace(text) {
    return String(text == null ? '' : text)
      .replace(/&#(?:x0*9|9);/gi, '\t')
      .replace(/(?:&nbsp;|&#160;|&#x0*a0;)/gi, ' ')
      .replace(/\u00a0/g, ' ');
  }

  function cleanLineForDiff(line) {
    const yen = '\u00A5';
    return normalizeDiffWhitespace(line)
      .replace(new RegExp('[\\\\' + yen + ']+_', 'g'), '_')
      .replace(new RegExp('[\\\\' + yen + ']{2,}\\*', 'g'), '\\*')
      .replace(new RegExp('[\\\\' + yen + ']+&', 'g'), '&')
      // Normalize section markers: \[[ or [[ → [[ (VS Code auto-escapes [[)
      .replace(/\\\[/g, '[')
      // Strip inline HTML tags so formatting-only changes don't cause false diffs
      .replace(/<\/?(code|b|strong|em|i|u|s|mark|span|br|div)\b[^>]*>/gi, '')
      // Strip trailing full-width spaces (\u3000), tabs, and regular spaces
      // md-watcher sometimes preserves trailing \u3000 from source .md files
      .replace(/[\u3000 \t]+$/, '');
  }

  // Line-based diff following snapshot-history.ps1 logic
  function computeLegacyDiff(oldLines, newLines) {
    const oldCleaned = oldLines.map(cleanLineForDiff);
    const newCleaned = newLines.map(cleanLineForDiff);
    const oldSet = new Set(oldCleaned);
    const fullWidthSpace = '\u3000';

    const sectionStack = [];
    let currentSub = null;
    let currentSubIsNew = false;
    const updates = new Map();
    const updateOrder = [];

    // Table runs: consecutive new "| ... |" snapshot lines belonging to one table
    // are wrapped with |TABLE_START| / |TABLE_END| markers so the 本日更新 view can
    // render them as a single table instead of dropping them.
    let tableRunKey = null;
    function closeTableRun() {
      if (tableRunKey === null) return;
      const runItems = updates.get(tableRunKey);
      if (runItems) runItems.push('|TABLE_END|');
      tableRunKey = null;
    }

    let inCodeFence = false;
    let codeFenceLines = [];
    let codeFenceHasNew = false;
    let codeFenceKey = null;
    let codeFenceOpen = null;

    // Blank line continuation tracking (matches watcher's lastNewKey logic)
    let lastNewKey = null;

    for (let li = 0; li < newCleaned.length; li++) {
      const sl = newCleaned[li];
      const origLine = newLines[li];

      if (/^```/.test(sl)) {
        closeTableRun();
        if (!inCodeFence) {
          inCodeFence = true;
          codeFenceOpen = sl;
          codeFenceLines = [];
          codeFenceHasNew = false;
          const secName = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1] : 'トップレベル';
          if (currentSubIsNew) {
            codeFenceKey = `${secName} >NEW> ${currentSub}`;
          } else {
            codeFenceKey = currentSub ? `${secName} > ${currentSub}` : secName;
          }
        } else {
          inCodeFence = false;
          if (codeFenceHasNew) {
            if (!updates.has(codeFenceKey)) { updates.set(codeFenceKey, []); updateOrder.push(codeFenceKey); }
            const items = updates.get(codeFenceKey);
            items.push(codeFenceOpen);
            codeFenceLines.forEach(cl => items.push(cl));
            items.push('```');
          }
        }
        continue;
      }
      if (inCodeFence) {
        // Auto-close code fence if a structural marker (header/section) is encountered
        if (/^#{1,6}[ \t]+/.test(sl) || /^\s*\\?\[\\?\[/.test(sl)) {
          inCodeFence = false;
          if (codeFenceHasNew) {
            if (!updates.has(codeFenceKey)) { updates.set(codeFenceKey, []); updateOrder.push(codeFenceKey); }
            const items = updates.get(codeFenceKey);
            items.push(codeFenceOpen);
            codeFenceLines.forEach(cl => items.push(cl));
            items.push('```');
          }
          // Fall through to process this line normally
        } else {
          codeFenceLines.push(origLine);
          if (!oldSet.has(sl)) codeFenceHasNew = true;
          continue;
        }
      }

      // Table row line (blocksToSnapshot emits consecutive "| ... |" lines per table)
      if (/^\s*\|/.test(sl)) {
        if (sl.trim() !== '' && !oldSet.has(sl)) {
          const secName = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1] : 'トップレベル';
          const key = currentSubIsNew
            ? `${secName} >NEW> ${currentSub}`
            : (currentSub ? `${secName} > ${currentSub}` : secName);
          if (!updates.has(key)) { updates.set(key, []); updateOrder.push(key); }
          if (tableRunKey !== key) {
            closeTableRun();
            updates.get(key).push('|TABLE_START|');
            tableRunKey = key;
          }
          updates.get(key).push(sl.trim());
        } else {
          // Unchanged table row ends the current new-table run
          closeTableRun();
        }
        lastNewKey = null;
        continue;
      }
      // Any non-table line ends an open table run
      closeTableRun();

      // Section end
      if (/^\s*\\?\[\\?\[\/\\?\]\\?\]\s*$/.test(sl)) {
        if (sectionStack.length > 0) sectionStack.pop();
        currentSub = null;
        currentSubIsNew = false;
        lastNewKey = null;
      }
      // Section start
      else if (/^\s*\\?\[\\?\[\s*(.+?)\s*\\?\]\\?\]\s*$/.test(sl)) {
        const m = sl.match(/^\s*\\?\[\\?\[\s*(.+?)\s*\\?\]\\?\]\s*$/);
        sectionStack.push(m[1]);
        currentSub = null;
        currentSubIsNew = false;
        lastNewKey = null;
      }
      // Heading
      else if (/^#{1,6}[ \t]+(.+)$/.test(sl)) {
        const m = sl.match(/^#{1,6}[ \t]+(.+)$/);
        let sh = m[1];
        while (sh.startsWith(fullWidthSpace) || sh.startsWith('\t')) {
          sh = sh.substring(1);
        }
        sh = sh.trim();
        currentSubIsNew = !oldSet.has(sl);
        if (currentSubIsNew) {
          const secName = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1] : 'トップレベル';
          const newKey = `${secName} >NEW> ${sh}`;
          if (!updates.has(newKey)) { updates.set(newKey, []); updateOrder.push(newKey); }
        }
        currentSub = sh;
        lastNewKey = null;
      }
      // Blank line: check continuation (watcher's lastNewKey logic)
      else if (sl.trim() === '' && lastNewKey !== null) {
        // Count consecutive blanks
        let blankCount = 1;
        let foundContinuation = false;
        const lookAhead = Math.min(li + 6, newCleaned.length);
        for (let pk = li + 1; pk < lookAhead; pk++) {
          const pkLine = newCleaned[pk];
          if (pkLine.trim() === '') { blankCount++; continue; }
          // Next non-blank line: is it new content?
          if (!oldSet.has(pkLine) && !/^\s*\|/.test(pkLine) && !/^```/.test(pkLine)
              && !/^#{1,6}[ \t]/.test(pkLine) && !/^\s*\\?\[\\?\[/.test(pkLine)) {
            foundContinuation = true;
          }
          break;
        }
        if (foundContinuation) {
          // blankCount==1: within-paragraph blank (from <br><br>), small gap
          // blankCount>=2: between-paragraph break, larger gap
          const items = updates.get(lastNewKey);
          if (items) {
            if (blankCount >= 2) {
              items.push('|PARAGRAPH_BREAK|');
            } else {
              items.push('|BLANK|');
            }
          }
          // Skip consumed blank lines
          li += blankCount - 1;
        } else {
          lastNewKey = null;
        }
      }
      // New content line
      else if (sl.trim() !== '' && !/^\s*\|/.test(sl) && !oldSet.has(sl)) {
        let display = origLine;
        const eqMatch = origLine.match(/^(=+)\s+(.+?)\s+=+\s*$/);
        if (eqMatch) {
          display = eqMatch[2];
        } else {
          // Convert leading tabs to &emsp; for indent preservation
          let tabCount = 0;
          while (/^(&#x09;|\t)/.test(display)) {
            display = display.replace(/^(&#x09;|\t)/, '');
            tabCount++;
          }
          if (tabCount > 0) {
            display = '\u2003'.repeat(tabCount) + display;
          }
        }
        const secName = sectionStack.length > 0 ? sectionStack[sectionStack.length - 1] : 'トップレベル';
        let key;
        if (currentSubIsNew) {
          key = `${secName} >NEW> ${currentSub}`;
        } else {
          key = currentSub ? `${secName} > ${currentSub}` : secName;
        }
        if (!updates.has(key)) { updates.set(key, []); updateOrder.push(key); }
        updates.get(key).push(display);
        lastNewKey = key;
      }
      else {
        // Existing line or plain blank: reset continuation
        lastNewKey = null;
      }
    }

    // Close any table run that reached the end of the document
    closeTableRun();

    // Handle unclosed code fence (flush accumulated lines)
    if (inCodeFence && codeFenceHasNew) {
      if (!updates.has(codeFenceKey)) { updates.set(codeFenceKey, []); updateOrder.push(codeFenceKey); }
      const items = updates.get(codeFenceKey);
      items.push(codeFenceOpen);
      codeFenceLines.forEach(cl => items.push(cl));
      items.push('```');
    }

    return { updates, updateOrder };
  }
  return {
    canonicalizeRichTextForDiff: canonicalizeRichTextForDiff,
    balanceInlineTagsMultiline: balanceInlineTagsMultiline,
    flattenBlocks: flattenBlocks,
    blocksToSnapshot: blocksToSnapshot,
    computeDiff: computeDiff,
    normalizeDiffWhitespace: normalizeDiffWhitespace,
    cleanLineForDiff: cleanLineForDiff,
    computeLegacyDiff: computeLegacyDiff
  };
}));
