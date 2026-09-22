// ============================================================
//  やるべきこと-editor / app.js — Block-based WYSIWYG editor
// ============================================================

(() => {
  'use strict';

  // --- State ---
  const DEFAULT_DOCUMENT_TITLE = 'やるべきこと';
  const DEFAULT_AUTOSAVE_INTERVAL_MS = 2 * 60 * 1000;
  const DEFAULT_REDO_LIMIT = 100;

  // ── フォント設定 ───────────────────────────────────────────────
  // 画面の文字と、コードの等幅文字を別々に選べるようにする。
  // 値は「選択肢の名前」だけを保存し、実際の font-family はこの表から引く。
  // 生の CSS を保存しない理由: このデータは配布用HTMLに丸ごと埋め込まれて他人に渡るので、
  // 書き込まれた文字列をそのまま CSS に流し込むと、受け取った側のページを壊せてしまう。
  // 「自分で指定」だけは自由入力だが、下の sanitizeFontFamily で危険な文字を落としてから使う。
  const DEFAULT_FONT_SIZE_BASE = 15;
  const MIN_FONT_SIZE_BASE = 12;
  const MAX_FONT_SIZE_BASE = 22;

  const UI_FONT_PRESETS = {
    default:  { label: '既定（Segoe UI / 游ゴシック UI）', stack: "'Segoe UI', 'Yu Gothic UI', 'Meiryo', sans-serif" },
    yugothic: { label: '游ゴシック',                       stack: "'Yu Gothic UI', 'Yu Gothic', 'Meiryo', sans-serif" },
    meiryo:   { label: 'メイリオ',                         stack: "'Meiryo', 'Yu Gothic UI', sans-serif" },
    bizud:    { label: 'BIZ UDPゴシック（読みやすさ重視）', stack: "'BIZ UDPGothic', 'Meiryo', sans-serif" },
    mincho:   { label: '游明朝（明朝体）',                  stack: "'Yu Mincho', 'YuMincho', 'MS Mincho', serif" },
    custom:   { label: '自分で指定…',                      stack: null }
  };

  const CODE_FONT_PRESETS = {
    default:  { label: '既定（JetBrains Mono / Consolas）', stack: "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace" },
    consolas: { label: 'Consolas',                          stack: "'Consolas', monospace" },
    cascadia: { label: 'Cascadia Mono',                     stack: "'Cascadia Mono', 'Consolas', monospace" },
    bizudg:   { label: 'BIZ UDゴシック（等幅・日本語込み）', stack: "'BIZ UDGothic', 'MS Gothic', monospace" },
    msgothic: { label: 'MS ゴシック',                       stack: "'MS Gothic', monospace" },
    custom:   { label: '自分で指定…',                       stack: null }
  };

  // 自由入力のフォント名から、CSS の宣言を抜け出せる文字を落とす。
  // ここを通ったものだけを font-family の値として使う。
  function sanitizeFontFamily(raw) {
    if (typeof raw !== 'string') return '';
    let v = raw.replace(/[;{}<>\\]/g, ' ')     // 宣言・ブロック・タグを閉じさせない
               .replace(/\/\*|\*\//g, ' ')       // コメントを開かせない
               .replace(/url\s*\(/gi, ' ')        // 外部読み込みをさせない
               .replace(/expression\s*\(/gi, ' ')
               .replace(/\s+/g, ' ')
               .trim();
    if (v.length > 120) v = v.slice(0, 120).trim();
    return v;
  }

  // 保存された設定から、実際に使う font-family の文字列を作る
  function resolveFontStack(presets, presetKey, customValue, fallbackKey) {
    const preset = presets[presetKey];
    if (preset && preset.stack) return preset.stack;
    if (presetKey === 'custom') {
      const clean = sanitizeFontFamily(customValue);
      // 指定したフォントが入っていない環境でも読めるよう、既定を後ろに残す
      if (clean) return clean + ', ' + presets[fallbackKey].stack;
    }
    return presets[fallbackKey].stack;
  }

  const INTERNAL_BLOCK_CLIPBOARD_TYPE = 'application/x-md-editor-blocks';
  const UNKNOWN_ENTER_FALLBACK_DELAY_MS = 24;
  const RECENT_COMPOSITION_GUARD_MS = 160;
  const IME_DEBUG_LOG_LIMIT = 24;
  const EDITABLE_FILLER_ATTR = 'data-editor-filler';
  const EDITABLE_FILLER_CHAR = '\u200b';

  let content = createDefaultContent();
  let isViewMode = new URLSearchParams(location.search).get('mode') === 'view';
  let activeMenu = null;
  let lastFocusedBlockId = null;
  let lastSavedContentJson = '';
  let lastSavedAt = null;
  let saveInFlight = false;
  let autosaveTimerId = null;
  let syncWatchTimerId = null;        // 別PCの更新を監視するタイマー
  let knownContentVersion = null;     // 自分が把握している共有データの版
  let lastLocalSaveAt = 0;            // 直近で自分が保存した時刻（自己更新の誤検知回避）
  let externalChangeBannerEl = null;  // 「他のPCで更新あり」バー
  let isLightMode = localStorage.getItem('theme') === 'light';
  let pendingHistoryShortcut = null;
  let reorgModeActive = false;
  const editableHistoryState = new WeakMap();
  const editableSelectionRanges = new WeakMap();
  const composingEditableState = new WeakSet();
  const compositionJustEndedEditable = new WeakSet();
  const enterHandledByKeydown = new WeakSet();
  const pendingUnknownEnterFallback = new WeakMap();
  const recentCompositionActivity = new WeakMap();
  const expandedCodeBlockIds = new Set();
  const selectedBlockIds = new Set();

  const NAV_COLLAPSE_STORAGE_KEY = 'navCollapsedSectionIds';
  const navCollapsedSectionIds = loadNavCollapsedSectionIds();

  // 左ナビ枠全体の開閉状態（セクション個別の開閉=navCollapsedSectionIds とは別物）
  const NAV_PANE_COLLAPSE_STORAGE_KEY = 'navPaneCollapsed';
  let isNavPaneCollapsed = localStorage.getItem(NAV_PANE_COLLAPSE_STORAGE_KEY) === '1';

  // --- User preference guardrails ---
  // 1. 初期表示では各セクションをすべて閉じた状態にしておく。
  // 2. 折りたたみ中のセクション直下には、本日更新分の冒頭3〜5行だけを出し、クリックで続きから編集できるようにする。
  // 3. 共有HTMLは別物の画面にせず、現在の閲覧モードをそのまま配れる形で保つ。
  // 4. ライトモードは本文を明るく保ちつつ、コードブロックは VS Code っぽい暗め配色を許容する。
  // 5. 左ナビは折りたたみ対応とし、ユーザーが閉じた状態はスクロールで勝手に解除しない。

  // --- DOM refs ---
  const $ = (s) => document.querySelector(s);
  const blocksContainer = $('#blocksContainer');
  const titleDisplay = $('#titleDisplay');

  // Track last focused block for toolbar insertion
  document.addEventListener('focusin', (e) => {
    const blockEl = e.target.closest('[data-block-id]');
    if (blockEl) lastFocusedBlockId = blockEl.dataset.blockId;
    ensureEditableHistoryState(e.target);
  });
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    captureEditableSelection(selection.anchorNode || document.activeElement);
  });
  const navList = $('#navList');
  const todaySection = $('#todaySection');
  const todaySectionMain = $('#todaySectionMain');
  const toast = $('#toast');
  const imeDebug = createImeDebugPanel();
  if (imeDebug && imeDebug.panel) imeDebug.panel.style.display = 'none';

  blocksContainer.addEventListener('beforeinput', (e) => {
    if (isCompositionInputEvent(e)) markRecentCompositionActivity(e.target);
    ensureEditableHistoryState(e.target);
    clearPendingUnknownEnterFallback(e.target);
    if (e.inputType !== 'insertParagraph' && e.inputType !== 'insertLineBreak') return;

    const editableEl = getTextEditingElement(e.target);
    if (!editableEl) return;
    const blockEl = editableEl.closest('.block[data-block-id]');
    if (!blockEl) return;
    const found = findBlockList(blockEl.dataset.blockId, content.blocks);
    const block = found ? found.list[found.index] : null;
    if (!block || (block.type !== 'heading' && block.type !== 'paragraph')) return;

    // Always block browser default paragraph/linebreak insertion
    e.preventDefault();
    // If keydown already processed this Enter, or IME is active, skip
    if (enterHandledByKeydown.has(editableEl)) return;
    if (e.isComposing || composingEditableState.has(editableEl)) return;
    if (compositionJustEndedEditable.has(editableEl)) return;
    // Fallback: handle Enter that didn't come through keydown
    performParagraphEnter(editableEl);
  });
  blocksContainer.addEventListener('compositionstart', (e) => {
    const editableEl = getTextEditingElement(e.target);
    if (!editableEl) return;
    markRecentCompositionActivity(editableEl);
    clearPendingUnknownEnterFallback(editableEl);
    composingEditableState.add(editableEl);
  });
  blocksContainer.addEventListener('compositionupdate', (e) => {
    const editableEl = getTextEditingElement(e.target);
    if (!editableEl) return;
    markRecentCompositionActivity(editableEl);
  });
  blocksContainer.addEventListener('compositionend', (e) => {
    const editableEl = getTextEditingElement(e.target);
    if (!editableEl) return;
    markRecentCompositionActivity(editableEl);
    clearPendingUnknownEnterFallback(editableEl);
    composingEditableState.delete(editableEl);
    compositionJustEndedEditable.add(editableEl);
    setTimeout(() => compositionJustEndedEditable.delete(editableEl), 0);
    // IMEがフィラースパン内にテキストを書き込んだ場合に即座に正規化する
    rescueFillerText(editableEl);
    // IME確定テキストをundo履歴の1ステップとして記録する。
    // （変換中の input は e.isComposing で記録対象外のため、ここで明示的に記録しないと
    //   確定した日本語入力が履歴に残らず、Ctrl+Zで一気に消えてしまう）
    recordEditableHistorySnapshot(editableEl);
  });
  blocksContainer.addEventListener('input', (e) => {
    pendingHistoryShortcut = null;
    if (isCompositionInputEvent(e)) markRecentCompositionActivity(e.target);
    clearPendingUnknownEnterFallback(e.target);
    syncEditedBlockAndRefreshStatus(e.target);
    if (e.isComposing) return;
    recordEditableHistorySnapshot(e.target);
  });
  blocksContainer.addEventListener('change', (e) => {
    pendingHistoryShortcut = null;
    clearPendingUnknownEnterFallback(e.target);
    syncEditedBlockAndRefreshStatus(e.target);
    recordEditableHistorySnapshot(e.target);
  });

  // ============================================================
  //  Utilities
  // ============================================================

  function uid() {
    return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function normalizeNonEmptyString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
  }

  function createDefaultAppConfig(baseTitle) {
    const title = normalizeNonEmptyString(baseTitle, DEFAULT_DOCUMENT_TITLE);
    return {
      displayTitle: title,
      documentTitle: title,
      autosaveIntervalMs: DEFAULT_AUTOSAVE_INTERVAL_MS,
      redoLimit: DEFAULT_REDO_LIMIT,
      fontUi: 'default',
      fontUiCustom: '',
      fontCode: 'default',
      fontCodeCustom: '',
      fontSizeBase: DEFAULT_FONT_SIZE_BASE
    };
  }

  function createDefaultContent() {
    const appConfig = createDefaultAppConfig();
    return {
      title: appConfig.documentTitle,
      lastModified: '',
      blocks: [],
      stickyNotes: [],
      appConfig
    };
  }

  function normalizeAppConfig(rawAppConfig, legacyTitle) {
    const defaults = createDefaultAppConfig(legacyTitle);
    const source = rawAppConfig && typeof rawAppConfig === 'object' ? rawAppConfig : {};

    return {
      displayTitle: normalizeNonEmptyString(source.displayTitle, defaults.displayTitle),
      documentTitle: normalizeNonEmptyString(source.documentTitle, defaults.documentTitle),
      autosaveIntervalMs: normalizePositiveInteger(source.autosaveIntervalMs, defaults.autosaveIntervalMs),
      redoLimit: normalizePositiveInteger(source.redoLimit, defaults.redoLimit),
      fontUi: UI_FONT_PRESETS[source.fontUi] ? source.fontUi : defaults.fontUi,
      fontUiCustom: sanitizeFontFamily(source.fontUiCustom),
      fontCode: CODE_FONT_PRESETS[source.fontCode] ? source.fontCode : defaults.fontCode,
      fontCodeCustom: sanitizeFontFamily(source.fontCodeCustom),
      fontSizeBase: clampFontSize(source.fontSizeBase, defaults.fontSizeBase)
    };
  }

  function clampFontSize(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(MAX_FONT_SIZE_BASE, Math.max(MIN_FONT_SIZE_BASE, Math.round(n)));
  }

  function normalizeContentData(rawContent) {
    const source = rawContent && typeof rawContent === 'object' ? rawContent : {};
    const legacyTitle = normalizeNonEmptyString(source.title, DEFAULT_DOCUMENT_TITLE);
    const appConfig = normalizeAppConfig(source.appConfig, legacyTitle);

    return {
      ...source,
      title: appConfig.documentTitle,
      lastModified: typeof source.lastModified === 'string' ? source.lastModified : '',
      blocks: Array.isArray(source.blocks) ? source.blocks : [],
      stickyNotes: Array.isArray(source.stickyNotes) ? source.stickyNotes : [],
      appConfig
    };
  }

  function getAppConfig() {
    content = normalizeContentData(content);
    return content.appConfig;
  }

  function getDisplayTitle() {
    return getAppConfig().displayTitle || DEFAULT_DOCUMENT_TITLE;
  }

  function getDocumentTitle() {
    return getAppConfig().documentTitle || DEFAULT_DOCUMENT_TITLE;
  }

  function getAutosaveIntervalMs() {
    return getAppConfig().autosaveIntervalMs || DEFAULT_AUTOSAVE_INTERVAL_MS;
  }

  function getRedoLimit() {
    return getAppConfig().redoLimit || DEFAULT_REDO_LIMIT;
  }

  function updateAppConfig(partialConfig) {
    const currentConfig = getAppConfig();
    const mergedConfig = {
      ...currentConfig,
      ...(partialConfig || {})
    };

    content.appConfig = normalizeAppConfig(mergedConfig, mergedConfig.documentTitle || currentConfig.documentTitle);
    content.title = content.appConfig.documentTitle;
    applyDocumentMetadata();
    return content.appConfig;
  }

  function applyDocumentMetadata() {
    const displayTitle = getDisplayTitle();
    if (titleDisplay) titleDisplay.textContent = displayTitle;
    document.title = getDocumentTitle();
    applyFontSettings(getAppConfig(), document.documentElement);
  }

  // style.css の :root で定義した3つのフォント変数を、設定の内容で上書きする。
  // 配布用HTML側でも同じ関数を使うので、引数で対象要素を受け取る。
  function applyFontSettings(appConfig, rootEl) {
    if (!rootEl || !appConfig) return;
    const ui = resolveFontStack(UI_FONT_PRESETS, appConfig.fontUi, appConfig.fontUiCustom, 'default');
    const code = resolveFontStack(CODE_FONT_PRESETS, appConfig.fontCode, appConfig.fontCodeCustom, 'default');
    rootEl.style.setProperty('--font-ui', ui);
    rootEl.style.setProperty('--font-code', code);
    rootEl.style.setProperty('--font-note', ui);
    rootEl.style.setProperty('--font-size-base', clampFontSize(appConfig.fontSizeBase, DEFAULT_FONT_SIZE_BASE) + 'px');
  }

  function loadNavCollapsedSectionIds() {
    try {
      const raw = localStorage.getItem(NAV_COLLAPSE_STORAGE_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function saveNavCollapsedSectionIds() {
    localStorage.setItem(NAV_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(navCollapsedSectionIds)));
  }

  function setNavSectionCollapsed(sectionId, collapsed) {
    if (!sectionId) return;
    if (collapsed) navCollapsedSectionIds.add(sectionId);
    else navCollapsedSectionIds.delete(sectionId);
    saveNavCollapsedSectionIds();
  }

  function syncNavCollapsedStateFromDom() {
    if (!navList || !navList.children.length) return;

    const collapsedIds = [];
    navList.querySelectorAll('.nav-section[data-section-id]').forEach(sectionEl => {
      if (sectionEl.classList.contains('nav-collapsed')) {
        collapsedIds.push(sectionEl.dataset.sectionId);
      }
    });

    navCollapsedSectionIds.clear();
    collapsedIds.forEach(id => navCollapsedSectionIds.add(id));
    saveNavCollapsedSectionIds();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function stripEditableFillerText(text) {
    return String(text || '').replaceAll(EDITABLE_FILLER_CHAR, '');
  }

  function removeEditableFillerNodes(container) {
    if (!container) return;
    container.querySelectorAll(`[${EDITABLE_FILLER_ATTR}]`).forEach(node => node.remove());
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const emptyNodes = [];
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      if (!textNode.textContent || !textNode.textContent.includes(EDITABLE_FILLER_CHAR)) continue;
      textNode.textContent = stripEditableFillerText(textNode.textContent);
      if (!textNode.textContent) emptyNodes.push(textNode);
    }
    emptyNodes.forEach(node => {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
  }

  function stripEditableFillerHtml(html) {
    if (typeof html !== 'string' || !html) return '';
    const container = document.createElement('div');
    container.innerHTML = html;
    removeEditableFillerNodes(container);
    return container.innerHTML;
  }

  // 段落/見出しの編集領域(contenteditable)はインライン+<br>のみを前提にしている。
  // 外部からペーストされた <div>/<p>/style 等のブロック要素が混入すると、
  // ブラウザのcontenteditableが改行(Enter)時にブロック分割を始めてしまい、
  // 「文末改行が2重になる」「新規段落に改行が差し込まれる」等の異常が起きる。
  // ここでブロック要素を <br> 区切りのインライン表現へ正規化し、style等の属性を除去する。
  // 保持するインラインタグは code / b / strong / em / i / u / s のみ。
  const SANITIZE_INLINE_KEEP = { CODE: 'code', B: 'b', STRONG: 'strong', EM: 'em', I: 'i', U: 'u', S: 's' };
  const SANITIZE_BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
  function sanitizeInlineEditableHtml(html) {
    if (typeof html !== 'string' || !html) return '';
    // ブロック要素も style 属性も無ければ既に正規形なのでそのまま返す（高速パス）
    if (!/<(?:div|p|h[1-6]|li|ul|ol|blockquote|section|article|header|footer|pre|table|thead|tbody|tr|td|th|span|font|a)\b/i.test(html)
        && !/\sstyle\s*=/i.test(html) && !/\sclass\s*=/i.test(html)) {
      return html;
    }
    const container = document.createElement('div');
    container.innerHTML = html;
    const escEl = document.createElement('div');
    const esc = (t) => { escEl.textContent = t == null ? '' : t; return escEl.innerHTML; };
    let out = '';
    const endsWithBr = () => /<br>\s*$/i.test(out);
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += esc(child.textContent);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName;
          if (tag === 'BR') {
            out += '<br>';
          } else if (SANITIZE_INLINE_KEEP[tag]) {
            const t = SANITIZE_INLINE_KEEP[tag];
            const openMark = out.length;
            out += '<' + t + '>';
            const afterOpen = out.length;
            walk(child);
            if (out.length === afterOpen) {
              out = out.slice(0, openMark); // 中身が空なら開きタグごと捨てる
            } else {
              out += '</' + t + '>';
            }
          } else if (SANITIZE_BLOCK_TAGS.has(tag)) {
            if (out && !endsWithBr()) out += '<br>';
            walk(child);
            if (!endsWithBr()) out += '<br>';
          } else {
            // span / a / font など未知のインライン要素はタグだけ外して中身を残す
            walk(child);
          }
        }
      }
    }
    walk(container);
    // <br> が3つ以上続いたら2つに圧縮し、末尾の<br>は除去
    out = out.replace(/(?:<br>\s*){3,}/gi, '<br><br>').replace(/(?:<br>\s*)+$/i, '');
    return out;
  }

  function renderEditableContentHtml(html) {
    const cleanHtml = sanitizeInlineEditableHtml(stripEditableFillerHtml(html))
      .replace(/<(code|b|strong|em|i|u|s)>\s*<\/\1>/gi, '');
    if (!/(?:<br\s*\/?>)+\s*$/i.test(cleanHtml)) return cleanHtml;
    return `${cleanHtml}<span ${EDITABLE_FILLER_ATTR}="true">${EDITABLE_FILLER_CHAR}</span>`;
  }

  function stripTags(html) {
    const d = document.createElement('div');
    d.innerHTML = stripEditableFillerHtml(html);
    return stripEditableFillerText(d.textContent || '');
  }

  function normalizeEditableHtml(html) {
    if (typeof html !== 'string' || !html) return '';

    // ブロック要素/style混入を先にインライン正規化（ペースト由来の汚染を保存時に除去）
    html = sanitizeInlineEditableHtml(html);
    if (!html) return '';

    const container = document.createElement('div');
    container.innerHTML = html;
    removeEditableFillerNodes(container);

    // Remove empty inline elements (e.g. <code></code> left after deleting text)
    container.querySelectorAll('code, b, strong, em, i, u, s').forEach(el => {
      if (!el.textContent.trim() && !el.querySelector('br')) {
        el.remove();
      }
    });

    const trimTrailingWhitespaceNodes = () => {
      while (container.lastChild) {
        if (container.lastChild.nodeType === Node.TEXT_NODE && !container.lastChild.textContent.trim()) {
          container.removeChild(container.lastChild);
          continue;
        }
        break;
      }
    };

    trimTrailingWhitespaceNodes();

    let trailingBreakCount = 0;
    while (container.lastChild) {
      if (container.lastChild.nodeType === Node.ELEMENT_NODE && container.lastChild.tagName === 'BR') {
        container.removeChild(container.lastChild);
        trailingBreakCount += 1;
        trimTrailingWhitespaceNodes();
        continue;
      }
      break;
    }

    const normalizedHtml = container.innerHTML;
    const normalizedText = stripEditableFillerText(stripTags(normalizedHtml)).replace(/\u00a0/g, '').trim();
    if (!normalizedText) return '';

    // \u672b\u5c3e\u306e\u5358\u72ec <br>\uff081\u500b\u3060\u3051\uff09\u306f\u3001\u6587\u672b\u3067Enter\u3092\u62bc\u3057\u305f\u6642\u306a\u3069\u306b\u751f\u3058\u308b\u7a7a\u884c
    // \u30a2\u30fc\u30c6\u30a3\u30d5\u30a1\u30af\u30c8\u3002\u3053\u308c\u3092\u4fdd\u5b58\u3059\u308b\u3068\u30d5\u30a3\u30e9\u30fc\u3068\u76f8\u307e\u3063\u3066\u300c\u6d88\u3048\u306a\u3044\u7a7a\u884c\u300d\u300cBS2\u56de\u300d
    // \u300c\u6b21\u6bb5\u843d\u3078\u306e\u6539\u884c\u6df7\u5165\u300d\u3092\u62db\u304f\u305f\u3081\u4fdd\u5b58\u3057\u306a\u3044\u3002
    // <br><br> \u4ee5\u4e0a\uff08\u30e6\u30fc\u30b6\u30fc\u304c\u610f\u56f3\u7684\u306b\u4f5c\u3063\u305f\u7a7a\u884c\uff09\u306f\u305d\u306e\u307e\u307e\u4fdd\u6301\u3059\u308b\u3002
    // \u203b\u30b5\u30fc\u30d0\u30fc\u306e stripSingleTrailingBrArtifact \u3068\u540c\u3058\u65b9\u91dd\u3002
    const trailingBreaksToKeep = trailingBreakCount >= 2 ? trailingBreakCount : 0;
    return normalizedHtml + '<br>'.repeat(trailingBreaksToKeep);
  }

  function createImeDebugPanel() {
    const panel = document.createElement('section');
    panel.id = 'imeDebugPanel';
    panel.className = 'ime-debug-panel';
    panel.innerHTML = `
      <div class="ime-debug-header">
        <div class="ime-debug-title-wrap">
          <strong>IME debug</strong>
          <span class="ime-debug-count"></span>
        </div>
        <div class="ime-debug-actions">
          <button type="button" class="ime-debug-clear">clear</button>
          <button type="button" class="ime-debug-toggle" aria-label="IME debug panel toggle">hide</button>
        </div>
      </div>
      <pre class="ime-debug-body"></pre>
    `;
    document.body.appendChild(panel);
    const state = {
      panel,
      body: panel.querySelector('.ime-debug-body'),
      count: panel.querySelector('.ime-debug-count'),
      toggle: panel.querySelector('.ime-debug-toggle'),
      clear: panel.querySelector('.ime-debug-clear'),
      entries: [],
      seq: 0,
      collapsed: false
    };
    state.toggle.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      renderImeDebugPanel();
    });
    state.clear.addEventListener('click', () => {
      state.entries = [];
      renderImeDebugPanel();
    });
    renderImeDebugPanel(state);
    return state;
  }

  function renderImeDebugPanel(state) {
    const panelState = state || imeDebug;
    if (!panelState) return;
    panelState.panel.classList.toggle('collapsed', panelState.collapsed);
    panelState.toggle.textContent = panelState.collapsed ? 'show' : 'hide';
    panelState.count.textContent = panelState.entries.length ? `last ${panelState.entries.length}` : 'idle';
    panelState.body.textContent = panelState.entries.length
      ? panelState.entries.map(formatImeDebugEntry).join('\n')
      : '再現直後の数行をそのまま送ってください';
  }

  function formatImeDebugEntry(entry) {
    const parts = [
      `#${entry.seq}`,
      entry.stage || '-',
      entry.type || '-',
      entry.key ? `key=${entry.key}` : null,
      entry.code ? `code=${entry.code}` : null,
      Number.isFinite(entry.keyCode) ? `keyCode=${entry.keyCode}` : null,
      Number.isFinite(entry.which) ? `which=${entry.which}` : null,
      entry.inputType ? `inputType=${entry.inputType}` : null,
      entry.data ? `data=${entry.data}` : null,
      `trusted=${entry.trusted ? 1 : 0}`,
      `composing=${entry.isComposing ? 1 : 0}`,
      `prevented=${entry.defaultPrevented ? 1 : 0}`,
      `flags[c=${entry.flags.composing},rc=${entry.flags.recentComposition},pb=${entry.flags.pendingBeforeInput},pu=${entry.flags.pendingUnknown}]`,
      entry.selection ? `selection=${entry.selection}` : null,
      entry.decision ? `decision=${entry.decision}` : null,
      entry.html ? `html=${entry.html}` : null
    ];
    return parts.filter(Boolean).join(' | ');
  }

  function summarizeImeDebugHtml(html) {
    return stripEditableFillerText(String(html || ''))
      .replace(/<br\s*\/?>/gi, '<br>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 72);
  }

  function getImeDebugFlags(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl) {
      return { composing: 0, recentComposition: 0, pendingUnknown: 0 };
    }
    return {
      composing: composingEditableState.has(editableEl) ? 1 : 0,
      recentComposition: hasRecentCompositionActivity(editableEl) ? 1 : 0,
      pendingUnknown: pendingUnknownEnterFallback.has(editableEl) ? 1 : 0
    };
  }

  function isCompositionInputEvent(event) {
    if (!event) return false;
    const inputType = typeof event.inputType === 'string' ? event.inputType.toLowerCase() : '';
    return !!(event.isComposing || inputType.includes('composition'));
  }

  function getTrailingEditableFiller(editableEl) {
    if (!editableEl || !editableEl.lastElementChild) return null;
    const lastEl = editableEl.lastElementChild;
    return lastEl.getAttribute(EDITABLE_FILLER_ATTR) === 'true' ? lastEl : null;
  }

  function syncEditableTrailingFiller(editableEl) {
    if (!isTrackedTextEditable(editableEl)) return null;
    // Rescue any user text that ended up inside filler spans before removing them
    editableEl.querySelectorAll(`[${EDITABLE_FILLER_ATTR}]`).forEach(node => {
      const textInFiller = (node.textContent || '').replace(EDITABLE_FILLER_CHAR, '').replace(/\u200B/g, '');
      if (textInFiller) {
        node.before(document.createTextNode(textInFiller));
      }
      node.remove();
    });
    const cleanHtml = stripEditableFillerHtml(editableEl.innerHTML);
    if (!/(?:<br\s*\/?>)+\s*$/i.test(cleanHtml)) return null;
    const filler = document.createElement('span');
    filler.setAttribute(EDITABLE_FILLER_ATTR, 'true');
    filler.textContent = EDITABLE_FILLER_CHAR;
    editableEl.appendChild(filler);
    return filler;
  }

  function moveRangeBeforeTrailingFiller(range, editableEl) {
    if (!range || !editableEl || !range.collapsed) return;
    const filler = getTrailingEditableFiller(editableEl);
    if (!filler) return;
    if (range.startContainer === editableEl && range.startOffset === editableEl.childNodes.length) {
      range.setStartBefore(filler);
      range.collapse(true);
      return;
    }
    if (isNodeInsideEditable(range.startContainer, filler)) {
      range.setStartBefore(filler);
      range.collapse(true);
    }
  }

  function isTrackedTextEditable(editableEl) {
    if (!editableEl || editableEl.matches('textarea, input[type="text"], input[type="date"]')) return false;
    const blockEl = editableEl.closest('.block[data-block-id]');
    if (!blockEl) return false;
    const found = findBlockList(blockEl.dataset.blockId, content.blocks);
    const block = found ? found.list[found.index] : null;
    return !!block && (block.type === 'heading' || block.type === 'paragraph');
  }

  function isNodeInsideEditable(node, editableEl) {
    if (!node || !editableEl) return false;
    if (node === editableEl) return true;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!element && editableEl.contains(element);
  }

  function isRangeInsideEditable(range, editableEl) {
    if (!range || !editableEl) return false;
    return isNodeInsideEditable(range.startContainer, editableEl) && isNodeInsideEditable(range.endContainer, editableEl);
  }

  function captureEditableSelection(target) {
    const editableEl = getTextEditingElement(target);
    if (!isTrackedTextEditable(editableEl)) return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0).cloneRange();
    moveRangeBeforeTrailingFiller(range, editableEl);
    if (!isRangeInsideEditable(range, editableEl)) return false;
    editableSelectionRanges.set(editableEl, range.cloneRange());
    return true;
  }

  function restoreEditableSelection(target) {
    const editableEl = getTextEditingElement(target);
    if (!isTrackedTextEditable(editableEl)) return 'untracked';
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const liveRange = sel.getRangeAt(0).cloneRange();
      moveRangeBeforeTrailingFiller(liveRange, editableEl);
      if (isRangeInsideEditable(liveRange, editableEl)) {
        sel.removeAllRanges();
        sel.addRange(liveRange);
        editableSelectionRanges.set(editableEl, liveRange.cloneRange());
        return 'live';
      }
    }

    const storedRange = editableSelectionRanges.get(editableEl);
    if (storedRange && isRangeInsideEditable(storedRange, editableEl)) {
      const nextRange = storedRange.cloneRange();
      moveRangeBeforeTrailingFiller(nextRange, editableEl);
      if (!nextRange.collapsed) {
        nextRange.collapse(false);
      }
      editableEl.focus();
      sel.removeAllRanges();
      sel.addRange(nextRange);
      editableSelectionRanges.set(editableEl, nextRange.cloneRange());
      return 'stored';
    }

    focusEditableHistoryTarget(editableEl);
    captureEditableSelection(editableEl);
    return 'fallback-end';
  }

  function getImeDebugSelection(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl) return 'none';
    const sel = window.getSelection();
    const hasLiveRange = !!(sel && sel.rangeCount && isRangeInsideEditable(sel.getRangeAt(0), editableEl));
    const hasStoredRange = !!(editableSelectionRanges.has(editableEl) && isRangeInsideEditable(editableSelectionRanges.get(editableEl), editableEl));
    return `${hasLiveRange ? 'live' : 'no-live'}/${hasStoredRange ? 'stored' : 'no-stored'}`;
  }

  function insertLineBreakAtCursor(target) {
    const selectionSource = restoreEditableSelection(target);
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return `${selectionSource}:no-range`;
    const range = sel.getRangeAt(0).cloneRange();
    const editableRoot = getTextEditingElement(target)
      || (sel.anchorNode && (sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement)?.closest('[contenteditable="true"]'));
    moveRangeBeforeTrailingFiller(range, editableRoot);
    if (!range.collapsed) {
      range.collapse(false);
    }
    const brCount = editableRoot ? ((editableRoot.innerHTML.match(/<br\s*\/?>/gi) || []).length) : 0;
    const editableInnerHtml = editableRoot ? stripEditableFillerHtml(editableRoot.innerHTML) : '';
    const editableTextContent = editableRoot ? stripEditableFillerText(editableRoot.textContent || '') : '';
    // フィラーが付いている<br>はユーザーが作った改行なので pristine 扱いしない
    // （フィラーなしの単独<br>はブラウザが空のcontenteditableに入れるプレースホルダー）
    const isPristineEmptyEditable = !!editableRoot
      && editableTextContent.trim() === ''
      && brCount <= 1
      && !getTrailingEditableFiller(editableRoot)
      && editableInnerHtml.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/gi, '').trim() === '';

    range.deleteContents();
    if (isPristineEmptyEditable) {
      // プレースホルダー<br>を消してから挿入しないと、
      // 末尾フィラー（syncEditableTrailingFiller）と二重になり余分な空行が生まれる
      editableRoot.innerHTML = '';
      range.setStart(editableRoot, 0);
      range.collapse(true);
    }
    const br = document.createElement('br');
    range.insertNode(br);
    range.setStartAfter(br);
    const trailingFiller = syncEditableTrailingFiller(editableRoot);
    if (trailingFiller && isNodeInsideEditable(range.startContainer, trailingFiller)) {
      range.setStartBefore(trailingFiller);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    if (isTrackedTextEditable(editableRoot)) {
      editableSelectionRanges.set(editableRoot, range.cloneRange());
    }
    return selectionSource;
  }

  function showToast(msg, duration) {
    toast.textContent = msg || '✓ 保存しました';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration || 2000);
  }

  function serializeContentForSave() {
    content = normalizeContentData(content);
    return JSON.stringify(content);
  }

  function formatSavedTime(date) {
    return new Intl.DateTimeFormat('ja-JP', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  function setSaveStatus(text, cssClass) {
    const saveStatus = $('#saveStatus');
    if (!saveStatus) return;
    // ★字を span に入れる。狭くなったら丸印だけ残して字を隠すため。
    //   textContent に直接入れると、印（::before）と字を別々に扱えない。
    saveStatus.textContent = '';
    const label = document.createElement('span');
    label.className = 'save-label';
    label.textContent = text;
    saveStatus.appendChild(label);
    // 狭いときは丸印だけになる。字が消えても読めるように、同じ文をホバーに出す。
    saveStatus.title = text;
    saveStatus.classList.remove('saved', 'dirty', 'pending', 'error');
    saveStatus.classList.add('show');
    if (cssClass) saveStatus.classList.add(cssClass);
  }

  function showSavedStatus() {
    const suffix = lastSavedAt ? ` ${formatSavedTime(lastSavedAt)}` : '';
    setSaveStatus(`保存済み${suffix}`, 'saved');
  }

  function showDirtyStatus() {
    setSaveStatus('未保存の変更あり', 'dirty');
  }

  function refreshSaveStatus() {
    if (saveInFlight) return;
    if (hasUnsavedChanges()) {
      showDirtyStatus();
      return;
    }
    showSavedStatus();
  }

  function syncEditedBlockAndRefreshStatus(target) {
    if (isViewMode || !target) return;
    const blockEl = target.closest('.block[data-block-id]');
    if (!blockEl || !blocksContainer.contains(blockEl)) return;
    syncBlockFromDOM(blockEl);
    refreshSaveStatus();
  }

  function hasUnsavedChanges() {
    return serializeContentForSave() !== lastSavedContentJson;
  }

  function parseSettingsInteger(input, options) {
    const opts = options || {};
    const min = typeof opts.min === 'number' ? opts.min : 1;
    const max = typeof opts.max === 'number' ? opts.max : Number.MAX_SAFE_INTEGER;
    const label = opts.label || '数値';
    const value = Number(input && input.value);

    if (!Number.isFinite(value) || value < min || value > max) {
      showToast(`${label}は ${min}〜${max} の範囲で入力してください`, 2200);
      if (input) input.focus();
      return null;
    }

    return Math.round(value);
  }

  function getTextEditingElement(target) {
    if (!target) return null;
    let element = null;
    if (typeof target.closest === 'function') {
      element = target;
    } else if (target.nodeType === Node.TEXT_NODE) {
      element = target.parentElement;
    } else if (document.activeElement && typeof document.activeElement.closest === 'function') {
      element = document.activeElement;
    }
    if (!element) return null;
    return element.closest('[contenteditable="true"], textarea, input[type="text"], input[type="date"]');
  }

  function isTextEditingTarget(target) {
    return !!getTextEditingElement(target);
  }

  function hasShortcutKey(event, keyName) {
    if (!event || !keyName) return false;
    const normalizedKeyName = String(keyName).toLowerCase();
    const shortcutKey = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (shortcutKey === normalizedKeyName) return true;
    const shortcutCode = typeof event.code === 'string' ? event.code.toLowerCase() : '';
    return shortcutCode === `key${normalizedKeyName}`;
  }

  function isEnterKeyEvent(event) {
    if (!event) return false;
    if (event.key === 'Enter' || event.code === 'Enter') return true;
    return event.keyCode === 13 || event.which === 13;
  }

  function readEditableHistoryValue(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl) return '';
    if (editableEl.matches('textarea, input[type="text"], input[type="date"]')) {
      return editableEl.value || '';
    }
    return normalizeEditableHtml(editableEl.innerHTML);
  }

  function ensureEditableHistoryState(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl) return null;
    let state = editableHistoryState.get(editableEl);
    if (state) return state;
    state = {
      entries: [readEditableHistoryValue(editableEl)],
      index: 0
    };
    editableHistoryState.set(editableEl, state);
    return state;
  }

  function recordEditableHistorySnapshot(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl) return false;
    const state = ensureEditableHistoryState(editableEl);
    const value = readEditableHistoryValue(editableEl);
    if (state.entries[state.index] === value) return false;

    if (state.index < state.entries.length - 1) {
      state.entries = state.entries.slice(0, state.index + 1);
    }

    state.entries.push(value);
    const historyLimit = Math.max(2, getAppConfig().redoLimit || DEFAULT_REDO_LIMIT);
    if (state.entries.length > historyLimit) {
      state.entries.splice(0, state.entries.length - historyLimit);
    }
    state.index = state.entries.length - 1;
    editableHistoryState.set(editableEl, state);
    return true;
  }

  function focusEditableHistoryTarget(editableEl) {
    if (!editableEl) return;
    editableEl.focus();
    if (editableEl.matches('textarea, input[type="text"], input[type="date"]')) {
      const cursor = editableEl.value.length;
      if (typeof editableEl.setSelectionRange === 'function') {
        editableEl.setSelectionRange(cursor, cursor);
      }
      if (editableEl.tagName === 'TEXTAREA') {
        editableEl.style.height = 'auto';
        editableEl.style.height = editableEl.scrollHeight + 'px';
      }
      return;
    }

    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    const filler = getTrailingEditableFiller(editableEl);
    if (filler) {
      range.setStartBefore(filler);
      range.collapse(true);
    } else {
      range.selectNodeContents(editableEl);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    if (isTrackedTextEditable(editableEl)) {
      editableSelectionRanges.set(editableEl, range.cloneRange());
    }
  }

  function markRecentCompositionActivity(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl) return;
    recentCompositionActivity.set(editableEl, Date.now());
  }

  function hasRecentCompositionActivity(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl || !recentCompositionActivity.has(editableEl)) return false;
    return (Date.now() - recentCompositionActivity.get(editableEl)) <= RECENT_COMPOSITION_GUARD_MS;
  }

  function armPendingUnknownEnterFallback(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl) return;
    const token = Date.now() + Math.random();
    pendingUnknownEnterFallback.set(editableEl, token);
    setTimeout(() => {
      if (pendingUnknownEnterFallback.get(editableEl) !== token) return;
      pendingUnknownEnterFallback.delete(editableEl);
      if (composingEditableState.has(editableEl)) return;
      if (hasRecentCompositionActivity(editableEl)) return;
      performParagraphEnter(editableEl);
    }, UNKNOWN_ENTER_FALLBACK_DELAY_MS);
  }

  function clearPendingUnknownEnterFallback(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl || !pendingUnknownEnterFallback.has(editableEl)) return false;
    pendingUnknownEnterFallback.delete(editableEl);
    return true;
  }

  function isAmbiguousProcessEnterEvent(event) {
    if (!event) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (isEnterKeyEvent(event) || isCompositionEnterEvent(event)) return false;
    if (hasRecentCompositionActivity(event.target)) return false;
    return event.key === 'Process' || event.key === 'Unidentified' || event.keyCode === 229 || event.which === 229;
  }

  function isCompositionEnterEvent(event) {
    if (!event) return false;
    const editableEl = getTextEditingElement(event.target);
    return !!(editableEl && composingEditableState.has(editableEl));
  }

  function performParagraphEnter(target) {
    clearPendingHistoryShortcut();
    ensureEditableHistoryState(target);
    rescueFillerText(target);
    insertLineBreakAtCursor(target);
    recordEditableHistorySnapshot(target);
    syncEditedBlockAndRefreshStatus(target);
  }

  // IMEがフィラースパン内にテキストを書き込んだ場合にテキストを外に出す
  function rescueFillerText(target) {
    const editableEl = target && (target.nodeType ? target : getTextEditingElement(target));
    if (!editableEl) return;
    const filler = getTrailingEditableFiller(editableEl);
    if (!filler) return;
    const userText = (filler.textContent || '').replace(/\u200B/g, '');
    if (!userText) return;

    const sel = window.getSelection();
    const cursorInFiller = sel && sel.rangeCount
      && isNodeInsideEditable(sel.getRangeAt(0).startContainer, filler);

    const rescuedNode = document.createTextNode(userText);
    filler.before(rescuedNode);
    filler.textContent = EDITABLE_FILLER_CHAR;

    if (cursorInFiller && sel) {
      const r = document.createRange();
      r.setStart(rescuedNode, userText.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  function applyEditableHistorySnapshot(editableEl, value) {
    if (!editableEl) return false;
    if (editableEl.matches('textarea, input[type="text"], input[type="date"]')) {
      editableEl.value = value || '';
    } else {
      editableEl.innerHTML = renderEditableContentHtml(value || '');
    }
    focusEditableHistoryTarget(editableEl);
    syncEditedBlockAndRefreshStatus(editableEl);
    return true;
  }

  function performEditableUndo(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl) return false;
    if (!editableHistoryState.get(editableEl)) return false;
    // まだ履歴に取り込まれていない現在状態（IME確定・インラインコード・太字など、
    // input イベントを伴わない変更）を先にスナップショットしてから1段戻す。
    // これをしないと最新の変更が記録されておらず、1回のCtrl+Zで段落の内容が
    // まるごと消えたように見えてしまう。
    recordEditableHistorySnapshot(editableEl);
    const state = editableHistoryState.get(editableEl);
    if (!state || state.index <= 0) return false;
    state.index -= 1;
    editableHistoryState.set(editableEl, state);
    return applyEditableHistorySnapshot(editableEl, state.entries[state.index]);
  }

  function performEditableRedo(target) {
    const editableEl = getTextEditingElement(target);
    if (!editableEl) return false;
    const state = editableHistoryState.get(editableEl);
    if (!state || state.index >= state.entries.length - 1) return false;
    state.index += 1;
    editableHistoryState.set(editableEl, state);
    return applyEditableHistorySnapshot(editableEl, state.entries[state.index]);
  }

  function cloneBlockData(block) {
    if (!block || typeof block !== 'object') return null;
    return JSON.parse(JSON.stringify(block));
  }

  function assignFreshBlockIds(block) {
    if (!block || typeof block !== 'object') return block;
    block.id = uid();
    if (Array.isArray(block.children)) {
      block.children.forEach(child => assignFreshBlockIds(child));
    }
    return block;
  }

  function registerExpandedCodeBlocks(block) {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'code' && block.id) expandedCodeBlockIds.add(block.id);
    if (Array.isArray(block.children)) {
      block.children.forEach(child => registerExpandedCodeBlocks(child));
    }
  }

  function collectBlocksByIds(blockIds) {
    return (blockIds || []).map(blockId => {
      const found = findBlockList(blockId, content.blocks);
      return found ? found.list[found.index] : null;
    }).filter(Boolean);
  }

  function hasExpandedTextSelection() {
    const activeEditable = getTextEditingElement(document.activeElement);
    if (activeEditable && activeEditable.matches('textarea, input[type="text"], input[type="date"]')) {
      const start = activeEditable.selectionStart;
      const end = activeEditable.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number' && start !== end) return true;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    return !!getTextEditingElement(selection.anchorNode) || !!getTextEditingElement(selection.focusNode);
  }

  function serializeBlockToPlainText(block) {
    if (!block || typeof block !== 'object') return '';

    if (block.type === 'heading' || block.type === 'paragraph') {
      return stripTags(block.text || '').trim();
    }

    if (block.type === 'code') {
      const language = block.language ? block.language.trim() : '';
      const fence = language ? `\`\`\`${language}` : '```';
      return [fence, block.content || '', '```'].join('\n').trim();
    }

    if (block.type === 'table') {
      const headerRow = Array.isArray(block.headers) ? block.headers.join('\t') : '';
      const bodyRows = Array.isArray(block.rows)
        ? block.rows.map(row => Array.isArray(row) ? row.join('\t') : '')
        : [];
      return [headerRow, ...bodyRows].filter(Boolean).join('\n').trim();
    }

    if (block.type === 'image') {
      return (block.alt || block.src || '').trim();
    }

    if (block.type === 'section') {
      const lines = [];
      if ((block.title || '').trim()) lines.push(block.title.trim());
      (block.children || []).forEach(child => {
        const childText = serializeBlockToPlainText(child);
        if (childText) lines.push(childText);
      });
      return lines.join('\n\n').trim();
    }

    return '';
  }

  function serializeBlocksToPlainText(blocks) {
    return (blocks || [])
      .map(block => serializeBlockToPlainText(block))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  function getSelectedBlocksForClipboard() {
    return collectBlocksByIds(getSelectedBlockIdsForDeletion());
  }

  function buildClipboardBlockPayload(blocks) {
    return JSON.stringify({
      version: 1,
      blocks: (blocks || []).map(block => cloneBlockData(block)).filter(Boolean)
    });
  }

  function parseClipboardBlockPayload(rawPayload) {
    if (typeof rawPayload !== 'string' || !rawPayload.trim()) return [];
    try {
      const parsed = JSON.parse(rawPayload);
      if (Array.isArray(parsed)) return parsed;
      return Array.isArray(parsed.blocks) ? parsed.blocks : [];
    } catch (_) {
      return [];
    }
  }

  // ── Markdown table paste support ──────────────────────────────
  // Split a markdown table row "| a | b |" into trimmed cell strings.
  function splitMarkdownTableRow(line) {
    let s = String(line == null ? '' : line).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.replace(/\\\|/g, '|').trim());
  }

  // True when a line is a markdown table delimiter, e.g. "| --- | :--: |".
  function isMarkdownTableDelimiter(line) {
    const s = String(line == null ? '' : line).trim();
    if (!s.includes('-')) return false;
    const cells = splitMarkdownTableRow(s);
    if (!cells.length) return false;
    return cells.every(c => /^:?-{1,}:?$/.test(c.replace(/\s+/g, '')));
  }

  // Build a mixed list of paragraph + table blocks from pasted markdown.
  // Returns [] when no markdown table is present, so plain-text paste keeps
  // its existing behavior.
  function createBlocksFromMarkdownText(text) {
    if (typeof text !== 'string') return [];
    const lines = text.replace(/\r\n?/g, '\n').split('\n');

    const isHeaderRow = (idx) =>
      idx + 1 < lines.length
      && lines[idx].includes('|')
      && lines[idx].trim() !== ''
      && isMarkdownTableDelimiter(lines[idx + 1]);

    if (!lines.some((_, idx) => isHeaderRow(idx))) return [];

    const blocks = [];
    let paragraphBuffer = [];

    const flushParagraphs = () => {
      if (!paragraphBuffer.length) return;
      const chunk = paragraphBuffer.join('\n');
      paragraphBuffer = [];
      chunk.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).forEach(paragraphText => {
        blocks.push({
          id: uid(),
          type: 'paragraph',
          text: paragraphText.split('\n').map(line => escapeHtml(line)).join('<br>'),
          indent: 0
        });
      });
    };

    let i = 0;
    while (i < lines.length) {
      if (isHeaderRow(i)) {
        flushParagraphs();
        const headers = splitMarkdownTableRow(lines[i]);
        i += 2; // skip header row + delimiter row
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          const cells = splitMarkdownTableRow(lines[i]);
          rows.push(headers.map((_, c) => escapeHtml(cells[c] != null ? cells[c] : '')));
          i++;
        }
        blocks.push({ id: uid(), type: 'table', headers, rows });
      } else {
        paragraphBuffer.push(lines[i]);
        i++;
      }
    }
    flushParagraphs();

    return blocks;
  }

  function createParagraphBlocksFromPlainText(text) {
    if (typeof text !== 'string') return [];
    const normalized = text.replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];

    const paragraphs = normalized
      .split(/\n{2,}/)
      .map(chunk => chunk.trim())
      .filter(Boolean);

    if (paragraphs.length < 2) return [];

    return paragraphs.map(paragraphText => ({
      id: uid(),
      type: 'paragraph',
      text: paragraphText
        .split('\n')
        .map(line => escapeHtml(line))
        .join('<br>'),
      indent: 0
    }));
  }

  function prepareBlocksForInsertion(blocks) {
    return (blocks || [])
      .map(block => cloneBlockData(block))
      .filter(Boolean)
      .map(block => assignFreshBlockIds(block));
  }

  function insertBlocksAfterAnchor(blockId, blocks) {
    if (!Array.isArray(blocks) || !blocks.length) return false;
    if (!blockId) {
      content.blocks.push(...blocks);
      return true;
    }

    let insertAfterId = blockId;
    blocks.forEach(block => {
      if (!insertBlockAfter(insertAfterId, block)) {
        content.blocks.push(block);
      }
      insertAfterId = block.id;
    });
    return true;
  }

  function replaceBlockWithBlocks(blockId, blocks) {
    const found = findBlockList(blockId, content.blocks);
    if (!found || !Array.isArray(blocks) || !blocks.length) return false;
    found.list.splice(found.index, 1, ...blocks);
    selectedBlockIds.delete(blockId);
    return true;
  }

  function getClipboardPasteContext(target) {
    const editableEl = getTextEditingElement(target);
    const blockEl = (editableEl && editableEl.closest('.block[data-block-id]'))
      || (target && typeof target.closest === 'function' ? target.closest('.block[data-block-id]') : null);
    if (!blockEl) {
      return {
        editableEl,
        blockEl: null,
        block: null,
        blockId: getActiveBlockId()
      };
    }

    const found = findBlockList(blockEl.dataset.blockId, content.blocks);
    return {
      editableEl,
      blockEl,
      block: found ? found.list[found.index] : null,
      blockId: blockEl.dataset.blockId
    };
  }

  function canHandleBlockPasteContext(context) {
    if (!context) return false;
    if (!context.editableEl) return true;
    return !!context.block && (context.block.type === 'heading' || context.block.type === 'paragraph');
  }

  function pasteBlocksIntoDocument(event, blocks) {
    const context = getClipboardPasteContext(event.target);
    if (!canHandleBlockPasteContext(context)) return false;

    const blocksToInsert = prepareBlocksForInsertion(blocks);
    if (!blocksToInsert.length) return false;

    event.preventDefault();
    event.stopPropagation();

    syncAllFromDOM();
    clearSelectedBlocks({ skipUiSync: true });

    const shouldReplaceEmptyTarget = !!context.editableEl
      && !!context.block
      && (context.block.type === 'heading' || context.block.type === 'paragraph')
      && isBlockEmpty(context.block);

    if (shouldReplaceEmptyTarget) {
      replaceBlockWithBlocks(context.block.id, blocksToInsert);
    } else {
      insertBlocksAfterAnchor(context.blockId, blocksToInsert);
    }

    blocksToInsert.forEach(block => registerExpandedCodeBlocks(block));

    armHistoryShortcut('undo');
    render();
    saveContent({
      successMessage: blocksToInsert.length > 1
        ? `${blocksToInsert.length}個のブロックを貼り付けました`
        : 'ブロックを貼り付けました',
      successDuration: 1600
    });

    const focusBlockId = blocksToInsert[0] && blocksToInsert[0].id;
    if (focusBlockId) {
      setTimeout(() => {
        focusEditableBlock(focusBlockId);
      }, 30);
    }

    return true;
  }

  function handleBlockPaste(event) {
    if (isViewMode || !event || !event.clipboardData) return false;

    const internalPayload = event.clipboardData.getData(INTERNAL_BLOCK_CLIPBOARD_TYPE);
    const clipboardBlocks = parseClipboardBlockPayload(internalPayload);
    if (clipboardBlocks.length) {
      return pasteBlocksIntoDocument(event, clipboardBlocks);
    }

    const plainText = event.clipboardData.getData('text/plain');

    const markdownBlocks = createBlocksFromMarkdownText(plainText);
    if (markdownBlocks.length && pasteBlocksIntoDocument(event, markdownBlocks)) {
      return true;
    }

    const paragraphBlocks = createParagraphBlocksFromPlainText(plainText);
    if (paragraphBlocks.length) {
      return pasteBlocksIntoDocument(event, paragraphBlocks);
    }

    return false;
  }

  function copySelectedBlocksToClipboard(event) {
    if (isViewMode || !event || !event.clipboardData) return [];
    if (!selectedBlockIds.size || hasExpandedTextSelection()) return [];

    const blocks = getSelectedBlocksForClipboard();
    if (!blocks.length) return [];

    event.preventDefault();
    try {
      event.clipboardData.setData(INTERNAL_BLOCK_CLIPBOARD_TYPE, buildClipboardBlockPayload(blocks));
    } catch (_) {}
    event.clipboardData.setData('text/plain', serializeBlocksToPlainText(blocks));
    return blocks;
  }

  function getSelectedBlockIdsForDeletion() {
    if (!selectedBlockIds.size) return [];

    return Array.from(document.querySelectorAll('.block[data-block-id]'))
      .map(blockEl => blockEl.dataset.blockId)
      .filter(blockId => {
        if (!selectedBlockIds.has(blockId)) return false;

        let parentBlock = document.getElementById(`block-${blockId}`)?.parentElement?.closest('.block[data-block-id]');
        while (parentBlock) {
          if (selectedBlockIds.has(parentBlock.dataset.blockId)) return false;
          parentBlock = parentBlock.parentElement?.closest('.block[data-block-id]');
        }

        return true;
      });
  }

  function syncSelectedBlockState() {
    if (isViewMode) {
      if (selectedBlockIds.size) selectedBlockIds.clear();
      document.body.classList.remove('has-block-selection');
      return;
    }

    Array.from(selectedBlockIds).forEach(blockId => {
      if (!document.getElementById(`block-${blockId}`)) selectedBlockIds.delete(blockId);
    });

    const bulkDeletionCount = getSelectedBlockIdsForDeletion().length;
    document.body.classList.toggle('has-block-selection', selectedBlockIds.size > 0);

    document.querySelectorAll('.block[data-block-id]').forEach(blockEl => {
      const blockId = blockEl.dataset.blockId;
      const isSelected = selectedBlockIds.has(blockId);
      blockEl.classList.toggle('block-selected', isSelected);

      const selectBtn = blockEl.querySelector('.ctrl-select');
      if (selectBtn) {
        selectBtn.classList.toggle('active', isSelected);
        selectBtn.textContent = isSelected ? '■' : '□';
        selectBtn.title = isSelected ? '選択解除' : '選択';
        selectBtn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      }

      const deleteBtn = blockEl.querySelector('.ctrl-del');
      if (deleteBtn) {
        deleteBtn.title = isSelected && bulkDeletionCount > 1
          ? `選択中の${bulkDeletionCount}件を削除`
          : '削除';
      }
    });
  }

  function clearSelectedBlocks(options) {
    if (!selectedBlockIds.size) return false;
    selectedBlockIds.clear();
    if (!options || !options.skipUiSync) syncSelectedBlockState();
    return true;
  }

  function toggleSelectedBlock(blockId) {
    if (!blockId) return false;
    if (selectedBlockIds.has(blockId)) selectedBlockIds.delete(blockId);
    else selectedBlockIds.add(blockId);
    syncSelectedBlockState();
    return selectedBlockIds.has(blockId);
  }

  function clearPendingHistoryShortcut() {
    pendingHistoryShortcut = null;
  }

  function armHistoryShortcut(mode) {
    pendingHistoryShortcut = mode || null;
  }

  const applyTheme = createViewerThemeApplier({
    bodyEl: document.body,
    getIsLightMode: () => isLightMode,
    themeButton: $('#btnThemeToggleFab'),
    getThemeIconHtml: (lightMode) => {
      return lightMode ? '<i class="ti ti-moon"></i>' : '<i class="ti ti-sun-high"></i>';
    }
  });

  // ── 左ナビ枠全体の開閉 ──
  // 閉じるボタンはナビ内、開くボタンは閉じている間だけ左端に出る固定ボタン。
  function applyNavPaneCollapsedState() {
    document.body.classList.toggle('nav-pane-collapsed', isNavPaneCollapsed);
  }
  function setNavPaneCollapsed(collapsed) {
    isNavPaneCollapsed = collapsed;
    localStorage.setItem(NAV_PANE_COLLAPSE_STORAGE_KEY, isNavPaneCollapsed ? '1' : '0');
    applyNavPaneCollapsedState();
  }
  const navCollapseButton = $('#btnNavCollapse');
  if (navCollapseButton) navCollapseButton.addEventListener('click', () => setNavPaneCollapsed(true));
  const navReopenButton = $('#btnNavReopen');
  if (navReopenButton) navReopenButton.addEventListener('click', () => setNavPaneCollapsed(false));
  applyNavPaneCollapsedState();

  function getStandaloneUtilityIconSvg(iconName) {
    if (iconName === 'theme-light') {
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v2.25"></path><path d="M12 18.75V21"></path><path d="M4.93 4.93l1.59 1.59"></path><path d="M17.48 17.48l1.59 1.59"></path><path d="M3 12h2.25"></path><path d="M18.75 12H21"></path><path d="M4.93 19.07l1.59-1.59"></path><path d="M17.48 6.52l1.59-1.59"></path><circle cx="12" cy="12" r="3.5"></circle></svg>';
    }
    if (iconName === 'theme-dark') {
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6.75 6.75 0 1 0 9 9A9 9 0 1 1 12 3z"></path></svg>';
    }
    if (iconName === 'top') {
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"></path><path d="M6 11l6-6 6 6"></path></svg>';
    }
    return '';
  }

  function applyViewerThemeState(options) {
    const themeOptions = options || {};
    if (themeOptions.bodyEl) {
      themeOptions.bodyEl.classList.toggle('light-mode', !!themeOptions.isLightMode);
    }

    updateThemeToggleButton(
      themeOptions.themeButton || null,
      !!themeOptions.isLightMode,
      themeOptions.getThemeIconHtml
    );

    if (themeOptions.topButton && typeof themeOptions.getTopIconHtml === 'function') {
      themeOptions.topButton.innerHTML = themeOptions.getTopIconHtml();
    }
  }

  function createViewerThemeApplier(options) {
    const themeOptions = options || {};
    return function() {
      applyViewerThemeState({
        bodyEl: typeof themeOptions.getBodyEl === 'function' ? themeOptions.getBodyEl() : themeOptions.bodyEl,
        isLightMode: typeof themeOptions.getIsLightMode === 'function' ? themeOptions.getIsLightMode() : themeOptions.isLightMode,
        themeButton: typeof themeOptions.getThemeButton === 'function' ? themeOptions.getThemeButton() : themeOptions.themeButton,
        topButton: typeof themeOptions.getTopButton === 'function' ? themeOptions.getTopButton() : themeOptions.topButton,
        getThemeIconHtml: themeOptions.getThemeIconHtml,
        getTopIconHtml: themeOptions.getTopIconHtml
      });
    };
  }

  function createThemeToggleHandler(options) {
    const toggleOptions = options || {};
    return function() {
      const currentIsLightMode = typeof toggleOptions.getIsLightMode === 'function'
        ? toggleOptions.getIsLightMode()
        : !!toggleOptions.isLightMode;
      const nextIsLightMode = !currentIsLightMode;

      if (typeof toggleOptions.setIsLightMode === 'function') toggleOptions.setIsLightMode(nextIsLightMode);
      if (typeof toggleOptions.onToggle === 'function') toggleOptions.onToggle(nextIsLightMode);
      if (typeof toggleOptions.applyTheme === 'function') toggleOptions.applyTheme(nextIsLightMode);
    };
  }

  function getVisibleElementId(element) {
    return element && element.style.display !== 'none' ? element.id : null;
  }

  function getStandaloneTodaySectionState(sectionEl) {
    return {
      visible: !!sectionEl && sectionEl.style.display !== 'none',
      collapsed: !!sectionEl && sectionEl.classList.contains('today-collapsed')
    };
  }

  function getStandaloneTodayPreviewMap(todayData) {
    return buildTodayPreviewMap(todayData, content.blocks);
  }

  // 共有HTML用: 本文の全セクションを閉じた状態にしたブロックのクローンを返す
  // （ライブの content.blocks は変更しない。ナビの開閉状態は別管理なので影響なし）
  function cloneBlocksWithAllSectionsCollapsed(blocks) {
    const clones = (blocks || []).map(block => cloneBlockData(block)).filter(Boolean);
    const walk = (list) => {
      for (const b of list || []) {
        if (b && b.type === 'section') b.collapsed = true;
        if (b && Array.isArray(b.children)) walk(b.children);
      }
    };
    walk(clones);
    return clones;
  }

  // 共有HTMLは自己完結（サーバー無し）なので、過去日の画像 (/images/<file> 参照) を
  // base64 データURLに埋め込み直す。今日の画像は既に base64 なのでそのまま。
  async function inlineImageSrcForExport(src) {
    if (typeof src !== 'string' || !src.startsWith('/images/')) return src;
    try {
      const res = await fetch(src);
      if (!res.ok) return src;
      const blob = await res.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(src);
        reader.readAsDataURL(blob);
      });
    } catch (_) {
      return src; // 取得できなければ参照のまま（壊すよりはマシ）
    }
  }

  async function inlineImageBlocksForExport(blocks) {
    for (const b of blocks || []) {
      if (b && b.type === 'image' && b.src) {
        b.src = await inlineImageSrcForExport(b.src);
      }
      if (b && Array.isArray(b.children)) {
        await inlineImageBlocksForExport(b.children);
      }
    }
    return blocks;
  }

  async function getStandaloneExportPayload(todayData) {
    ensureStickyNotes();
    syncNavCollapsedStateFromDom();
    const appConfig = getAppConfig();

    const exportBlocks = await inlineImageBlocksForExport(
      cloneBlocksWithAllSectionsCollapsed(content.blocks)
    );

    return {
      title: appConfig.documentTitle || 'ドキュメント',
      appConfig,
      content: {
        title: appConfig.documentTitle || 'ドキュメント',
        blocks: exportBlocks,
        stickyNotes: content.stickyNotes || []
      },
      isLightMode,
      navCollapsedSectionIds: Array.from(navCollapsedSectionIds),
      expandedCodeBlockIds: Array.from(expandedCodeBlockIds),
      todayStickyColor: localStorage.getItem('todayStickyColor') || '#339af0',
      todayPreviewByBlockId: getStandaloneTodayPreviewMap(todayData),
      todayDisplayText: todayDisplay(),
      todayData: todayData || null,
      todayNavState: getStandaloneTodaySectionState(todaySection),
      todayMainState: getStandaloneTodaySectionState(todaySectionMain)
    };
  }

  function escapeInlineScriptText(text) {
    return (text || '').replace(/<\/script/gi, '<\\/script');
  }

  function escapeInlineStyleText(text) {
    return (text || '').replace(/<\/style/gi, '<\\/style');
  }

  function escapeInlineJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  function standaloneViewerBootstrap(payload, getUtilityIconSvg, buildReadonlyBlockEl, buildNavigationTree, autoScrollNavWithin, getCollapsedAwareNavLink, setActiveNavLinkState, stripTags, findBlock) {
    payload = payload || {};

    var contentData = payload.content || { title: 'ドキュメント', blocks: [], stickyNotes: [] };
    var appConfig = payload.appConfig || {};
    var blocks = Array.isArray(contentData.blocks) ? contentData.blocks : [];
    var stickyNotes = Array.isArray(contentData.stickyNotes) ? contentData.stickyNotes : [];
    var navCollapsedIds = new Set(payload.navCollapsedSectionIds || []);
    var expandedCodeIds = new Set(payload.expandedCodeBlockIds || []);
    var todayPreviewByBlockId = payload.todayPreviewByBlockId || {};
    var isLightMode = !!payload.isLightMode;

    var navList = document.getElementById('navList');
    var sideNav = document.getElementById('sideNav');
    var blocksContainer = document.getElementById('blocksContainer');
    var todaySection = document.getElementById('todaySection');
    var todaySectionMain = document.getElementById('todaySectionMain');
    var stickyNotesContainer = document.getElementById('stickyNotesContainer');
    var navActivationState = { scrollSpySuppressed: false, scrollSpyTimer: null };

    // 本日更新の画像マーカー([画像#id])を、埋め込み blocks から実画像srcへ解決する。
    // 画像は payload に1回だけ埋め込まれており、ここでは参照するだけなのでファイルは重くならない。
    window.__resolveTodayImageSrc = function(blockId) {
      try {
        var ib = findBlock(blockId, blocks);
        if (ib && ib.type === 'image' && ib.src) return ib.src;
      } catch (_) {}
      return '';
    };
    // 共有HTMLでも本日更新の画像をクリックで拡大（外側/Escで縮小）
    (function setupViewerLightbox() {
      var lb = null;
      function closeLb() {
        if (!lb) return;
        lb.classList.remove('show');
        var el = lb; lb = null;
        setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 180);
      }
      document.addEventListener('click', function (e) {
        var img = e.target && e.target.closest && e.target.closest('img.today-image');
        if (!img) return;
        e.preventDefault();
        closeLb();
        var overlay = document.createElement('div');
        overlay.className = 'image-lightbox';
        overlay.addEventListener('click', closeLb);
        var big = document.createElement('img');
        big.className = 'image-lightbox-img';
        big.src = img.getAttribute('src');
        big.alt = '画像（拡大）';
        big.addEventListener('click', function (ev) { ev.stopPropagation(); });
        overlay.appendChild(big);
        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('show'); });
        lb = overlay;
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLb(); });
    })();

    document.title = appConfig.documentTitle || payload.title || contentData.title || document.title;

    var jumpHandlers = createViewerJumpHandlers({
      getBlockTarget: function(blockId) {
        return document.getElementById('block-' + blockId);
      },
      onExpanded: function(parentBlockId) {
        if (!parentBlockId) return;
        var sectionBlock = findBlock(parentBlockId, blocks);
        if (sectionBlock) sectionBlock.collapsed = false;
      },
      todayContainer: todaySectionMain
    });
    var jumpToBlock = jumpHandlers.jumpToBlock;
    var scrollToTodayMain = jumpHandlers.scrollToTodayMain;
    exposeViewerJumpHandlers({
      jumpToBlock: jumpToBlock,
      scrollToTodayMain: scrollToTodayMain
    });

    var setActiveNavLink = createNavLinkActivator(navActivationState, navList, sideNav);

    var renderReadonlyTree = createReadonlyTreeRenderer({
      expandedCodeIds: expandedCodeIds,
      todayPreviewByBlockId: todayPreviewByBlockId,
      onPreviewNavigate: function(ctx) {
        jumpToBlock(ctx.targetBlockId || ctx.block.id);
      },
      onSectionToggled: function() {},
      highlightCode: highlightCodeElement
    });

    var buildNavigation = createViewerNavigationRenderer({
      navRoot: navList,
      blocks: blocks,
      activateLink: setActiveNavLink,
      jumpToBlock: jumpToBlock,
      getTarget: function(blockId) {
        return document.getElementById('block-' + blockId);
      },
      onSectionExpanded: function(block) {
        if (block) block.collapsed = false;
      },
      isSectionCollapsed: function(blockId) { return navCollapsedIds.has(blockId); },
      getHeadingText: function(block) { return stripTags(block.text) || '(無題)'; },
      onSectionToggle: function(ctx) {
        if (ctx.isCollapsed) navCollapsedIds.add(ctx.block.id);
        else navCollapsedIds.delete(ctx.block.id);
      }
    });

    var renderStickyNotes = createStickyNotesRenderer({
      container: stickyNotesContainer,
      stickyNotes: stickyNotes,
      todayColor: payload.todayStickyColor || '#339af0',
      buildSticky: buildSticky
    });

    function buildSticky(note, isToday) {
      return buildStickyNoteElement(note, {
        isToday: isToday,
        onActivate: createStickyActivationHandler(note, {
          isToday: isToday,
          getTodayMainId: function() {
            return getVisibleElementId(todaySectionMain);
          },
          scrollToTodayMain: scrollToTodayMain,
          jumpToBlock: jumpToBlock,
          onMiss: scrollToPageTop
        })
      });
    }

    var renderTodaySections = createTodayPanelsRenderer({
      data: payload.todayData,
      displayText: payload.todayDisplayText || '',
      navContainer: todaySection,
      navVisible: !!(payload.todayNavState && payload.todayNavState.visible),
      navCollapsed: !!(payload.todayNavState && payload.todayNavState.collapsed),
      mainContainer: todaySectionMain,
      mainVisible: !!(payload.todayMainState && payload.todayMainState.visible),
      mainCollapsed: !!(payload.todayMainState && payload.todayMainState.collapsed),
      afterMainRender: applyTodayMainHighlighting
    });

    var applyTheme = createViewerThemeApplier({
      bodyEl: document.body,
      getIsLightMode: function() {
        return isLightMode;
      },
      themeButton: document.getElementById('btnThemeToggleFab'),
      topButton: document.getElementById('btnScrollTop'),
      getThemeIconHtml: function(lightMode) {
        return lightMode ? getUtilityIconSvg('theme-dark') : getUtilityIconSvg('theme-light');
      },
      getTopIconHtml: function() {
        return getUtilityIconSvg('top');
      }
    });

    var updateScrollTopButton = createScrollTopButtonUpdater(document.getElementById('btnScrollTop'));
    var updateScrollSpy = createStandardNavScrollSpyUpdater({
      navRoot: navList,
      navScroller: sideNav,
      getIsSuppressed: function() {
        return navActivationState.scrollSpySuppressed;
      },
      shouldSkipTarget: function(target) {
        return isTargetHiddenInCollapsedSection(target);
      }
    });
    var handleThemeToggle = createThemeToggleHandler({
      getIsLightMode: function() {
        return isLightMode;
      },
      setIsLightMode: function(nextIsLightMode) {
        isLightMode = nextIsLightMode;
      },
      applyTheme: applyTheme
    });
    var renderViewerDocument = createDocumentStructureRenderer({
      blocks: blocks,
      blocksContainer: blocksContainer,
      renderBlock: renderReadonlyTree,
      buildNavigation: buildNavigation,
      renderTodaySections: renderTodaySections,
      renderStickyNotes: renderStickyNotes
    });

    renderViewerDocument();
    applyTheme();
    updateScrollTopButton();
    updateScrollSpy();

    bindViewerUtilityButtons({
      themeButton: document.getElementById('btnThemeToggleFab'),
      topButton: document.getElementById('btnScrollTop'),
      onThemeToggle: handleThemeToggle
    });

    bindViewerScrollHandlers({
      onScrollSpy: updateScrollSpy,
      onScrollTop: updateScrollTopButton
    });
  }

  // 設定で選んだフォントを、配布用HTML にも持っていく。
  // 画面側は documentElement の inline style で当てているが、それは書き出しに乗らないので
  // ここで :root の上書き規則を組み立てて <style> に差し込む。
  function buildFontOverrideCss(appConfig) {
    const cfg = appConfig || {};
    const ui = resolveFontStack(UI_FONT_PRESETS, cfg.fontUi, cfg.fontUiCustom, 'default');
    const code = resolveFontStack(CODE_FONT_PRESETS, cfg.fontCode, cfg.fontCodeCustom, 'default');
    const size = clampFontSize(cfg.fontSizeBase, DEFAULT_FONT_SIZE_BASE);
    return ':root{--font-ui:' + ui + ';--font-code:' + code + ';--font-note:' + ui
         + ';--font-size-base:' + size + 'px}';
  }

  function buildStandaloneHtml(payload, css, hljsCss, hljsScriptBundle) {
    const exportBodyClass = payload.isLightMode ? 'view-mode light-mode' : 'view-mode';
    const fontOverrideCss = buildFontOverrideCss(payload.appConfig);
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml((payload.appConfig && payload.appConfig.documentTitle) || payload.title || 'ドキュメント')}</title>
<style>${escapeInlineStyleText(hljsCss)}</style>
<style>${escapeInlineStyleText(css)}
/* Export overrides */
body { padding: 0; }
.toolbar, .block-controls, .add-block-row, .table-controls, .sticky-modal-overlay { display: none !important; }
/* ツールバーが無いので、ナビと本文を画面最上部から始める */
body.view-mode nav#sideNav { top: 0; height: 100vh; }
body.view-mode main#mainContent { margin-top: 0; }
.block-section .section-header { cursor: pointer; }
.block-code pre { max-height: none; }
[contenteditable] { outline: none; }
/* ドキュメントタイトルは nav h2 の大文字化を打ち消す（原文の大小を保持） */
.export-document-title { font-size: 15px; font-weight: 600; color: var(--heading); margin: 0 0 12px; padding: 0; letter-spacing: -0.01em; text-transform: none; }
/* 設定で選んだフォント（書き出した時点のもの） */
${escapeInlineStyleText(fontOverrideCss)}
</style>
</head>
<body class="${exportBodyClass}">
<nav id="sideNav">
  <h2 class="export-document-title">${escapeHtml((payload.appConfig && payload.appConfig.documentTitle) || payload.title || 'ドキュメント')}</h2>
  <ul class="nav-list" id="navList"></ul>
  <div class="today-section" id="todaySection" style="display:none"></div>
</nav>
<main id="mainContent">
  <div id="blocksContainer"></div>
  <div class="today-section" id="todaySectionMain" style="display:none"></div>
</main>
<div class="sticky-notes-container" id="stickyNotesContainer"></div>
<div class="utility-fab-stack" id="utilityFabStack">
  <button id="btnThemeToggleFab" class="utility-fab" title="ライトモードに切り替え"></button>
  <button id="btnScrollTop" class="utility-fab scroll-top-btn" title="ページ上部へ移動"></button>
</div>
<script>${escapeInlineScriptText(hljsScriptBundle)}</script>
<script id="exportPayload" type="application/json">${escapeInlineJson(payload)}</script>
<script>
var EDITABLE_FILLER_ATTR = 'data-editor-filler';
var EDITABLE_FILLER_CHAR = '\u200b';
var stripEditableFillerText = ${stripEditableFillerText.toString()};
var removeEditableFillerNodes = ${removeEditableFillerNodes.toString()};
var stripEditableFillerHtml = ${stripEditableFillerHtml.toString()};
var stripTags = ${stripTags.toString()};
var showHeadingJumpMenu = ${showHeadingJumpMenu.toString()};
var applyViewerThemeState = ${applyViewerThemeState.toString()};
var createViewerThemeApplier = ${createViewerThemeApplier.toString()};
var createThemeToggleHandler = ${createThemeToggleHandler.toString()};
var getVisibleElementId = ${getVisibleElementId.toString()};
var scrollToPageTop = ${scrollToPageTop.toString()};
var createAnimationFrameThrottledHandler = ${createAnimationFrameThrottledHandler.toString()};
var bindViewerScrollHandlers = ${bindViewerScrollHandlers.toString()};
var escapeHtmlText = ${escapeHtmlText.toString()};
var renderTodayInlineHtml = ${renderTodayInlineHtml.toString()};
var hasTodayData = ${hasTodayData.toString()};
var normalizeTodayDisplayText = ${normalizeTodayDisplayText.toString()};
var buildTodayHeaderHtml = ${buildTodayHeaderHtml.toString()};
var buildTodayNavHtml = ${buildTodayNavHtml.toString()};
var renderTodayTableHtml = ${renderTodayTableHtml.toString()};
var splitMarkdownTableRow = ${splitMarkdownTableRow.toString()};
var renderTodayImageHtml = ${renderTodayImageHtml.toString()};
var buildTodayMainHtml = ${buildTodayMainHtml.toString()};
var renderTodayContainer = ${renderTodayContainer.toString()};
var renderTodayPanels = ${renderTodayPanels.toString()};
var createTodayPanelsRenderer = ${createTodayPanelsRenderer.toString()};
var applyTodayMainHighlighting = ${applyTodayMainHighlighting.toString()};
var buildReadonlyBlockEl = ${buildReadonlyBlockEl.toString()};
var buildNavigationTree = ${buildNavigationTree.toString()};
var createNavigationInteractionHandlers = ${createNavigationInteractionHandlers.toString()};
var renderNavigationList = ${renderNavigationList.toString()};
var renderViewerNavigation = ${renderViewerNavigation.toString()};
var createViewerNavigationRenderer = ${createViewerNavigationRenderer.toString()};
var autoScrollNavWithin = ${autoScrollNavWithin.toString()};
var createNavLinkActivator = ${createNavLinkActivator.toString()};
var getCollapsedAwareNavLink = ${getCollapsedAwareNavLink.toString()};
var setActiveNavLinkState = ${setActiveNavLinkState.toString()};
var activateNavLinkWithSuppression = ${activateNavLinkWithSuppression.toString()};
var buildStickyNoteElement = ${buildStickyNoteElement.toString()};
var activateStickyNavigation = ${activateStickyNavigation.toString()};
var createStickyActivationHandler = ${createStickyActivationHandler.toString()};
var buildStickyNotesFragment = ${buildStickyNotesFragment.toString()};
var renderStickyNotesList = ${renderStickyNotesList.toString()};
var createStickyNotesRenderer = ${createStickyNotesRenderer.toString()};
var bindViewerUtilityButtons = ${bindViewerUtilityButtons.toString()};
var updateThemeToggleButton = ${updateThemeToggleButton.toString()};
var setScrollTopButtonVisible = ${setScrollTopButtonVisible.toString()};
var createScrollTopButtonUpdater = ${createScrollTopButtonUpdater.toString()};
var isTargetHiddenInCollapsedSection = ${isTargetHiddenInCollapsedSection.toString()};
var findScrollSpyActiveLink = ${findScrollSpyActiveLink.toString()};
var updateStandardNavScrollSpy = ${updateStandardNavScrollSpy.toString()};
var createStandardNavScrollSpyUpdater = ${createStandardNavScrollSpyUpdater.toString()};
var flashElement = ${flashElement.toString()};
var expandCollapsedSectionAncestors = ${expandCollapsedSectionAncestors.toString()};
var revealBlockTarget = ${revealBlockTarget.toString()};
var revealTodayTarget = ${revealTodayTarget.toString()};
var createViewerJumpHandlers = ${createViewerJumpHandlers.toString()};
var exposeViewerJumpHandlers = ${exposeViewerJumpHandlers.toString()};
var normalizeHighlightLanguage = ${normalizeHighlightLanguage.toString()};
var getHighlightLanguageClass = ${getHighlightLanguageClass.toString()};
var highlightCodeElement = ${highlightCodeElement.toString()};
var renderDocumentStructure = ${renderDocumentStructure.toString()};
var createDocumentStructureRenderer = ${createDocumentStructureRenderer.toString()};
var createReadonlyTreeRenderer = ${createReadonlyTreeRenderer.toString()};
var getUtilityIconSvg = ${getStandaloneUtilityIconSvg.toString()};
var findBlock = ${findBlock.toString()};
(${standaloneViewerBootstrap.toString()})(JSON.parse(document.getElementById('exportPayload').textContent), getUtilityIconSvg, buildReadonlyBlockEl, buildNavigationTree, autoScrollNavWithin, getCollapsedAwareNavLink, setActiveNavLinkState, stripTags, findBlock);
<\/script>
</body>
</html>`;
  }

  const updateScrollTopButton = createScrollTopButtonUpdater($('#btnScrollTop'));
  const updateRegularNavScrollSpy = createStandardNavScrollSpyUpdater({
    navRoot: navList,
    getNavScroller: () => document.getElementById('sideNav'),
    shouldSkipTarget: (target) => isTargetHiddenInCollapsedSection(target)
  });

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  function todayDisplay() {
    const d = new Date();
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }

  function closeMenus() {
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  }

  // ============================================================
  //  API calls
  // ============================================================

  async function loadContent() {
    const res = await fetch('/api/content');
    content = normalizeContentData(await res.json());
    applyDocumentMetadata();
    return content;
  }

  async function saveContent(options) {
    const opts = options || {};
    const currentJson = serializeContentForSave();
    if (!opts.force && currentJson === lastSavedContentJson) {
      refreshSaveStatus();
      updateUndoRedoButtons();
      return { ok: true, skipped: true };
    }
    if (saveInFlight) {
      return { ok: false, skipped: true, reason: 'save-in-flight' };
    }

    saveInFlight = true;
    setSaveStatus(opts.reason === 'autosave' ? '自動保存中...' : '保存中...', 'pending');
    let result = { ok: false, error: 'save-failed' };
    try {
      const requestBody = opts.undoSnapshotJson
        ? JSON.stringify({
          content: JSON.parse(currentJson),
          undoSnapshot: JSON.parse(opts.undoSnapshotJson)
        })
        : currentJson;
      const res = await fetch('/api/content', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });
      const data = await res.json();
      if (data.ok) {
        lastSavedContentJson = currentJson;
        lastSavedAt = new Date();
        if (!opts.skipToast) showToast(opts.successMessage, opts.successDuration);
        // 保存ごとに本日更新セクションを更新
        refreshTodaySections();
        // 自分の保存を「別PCの更新」と誤検知しないよう、版の基準を更新する
        lastLocalSaveAt = Date.now();
        refreshSyncBaseline();
        dismissExternalChangeBanner();
      } else {
        setSaveStatus('保存失敗', 'error');
      }
      result = data;
    } catch (_) {
      setSaveStatus('保存失敗', 'error');
    } finally {
      saveInFlight = false;
    }

    if (result.ok) refreshSaveStatus();
    updateUndoRedoButtons();
    return result;
  }

  // ファイルとして受け取る書き出し（Markdown・履歴）。
  //
  // 以前は location.href で /api/... へ移動させていた。オフライン版では
  // それで動くが、オンライン版は /api/* を画面の中で処理しているので、
  // 移動にすると素通りしてしまう（404 のページへ飛ぶ）。
  // 両方で同じ動きになるよう、取ってきてから保存する形に統一した。
  //
  // ファイル名はサーバが Content-Disposition で指示してくる。
  // 名前の決め方を画面側にも書くと、2か所で食い違うので読み取って使う。
  async function downloadFromApi(url, fallbackName) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let msg = '書き出せませんでした（' + res.status + '）';
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
        alert(msg);
        return false;
      }
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      const name = m ? decodeURIComponent(m[1]) : (fallbackName || 'export.txt');

      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // すぐ消すと保存が始まる前に無効になる環境があるので、少し待ってから返す
      setTimeout(() => URL.revokeObjectURL(href), 60000);
      return true;
    } catch (e) {
      alert('書き出せませんでした: ' + (e && e.message || e));
      return false;
    }
  }

  async function resetTodayBaseline() {
    const res = await fetch('/api/reset-today-baseline', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || 'baseline reset failed');
    }
    await refreshTodaySections();
    return data;
  }

  function updateReorgModeUI() {
    const btn = $('#btnReorgMode');
    if (btn) {
      btn.classList.toggle('active', reorgModeActive);
      btn.innerHTML = reorgModeActive
        ? '<i class="ti ti-arrows-shuffle"></i> 整理中'
        : '<i class="ti ti-arrows-shuffle"></i> 整理';
    }
    document.body.classList.toggle('reorg-mode-active', reorgModeActive);
  }

  async function loadReorgModeState() {
    try {
      const res = await fetch('/api/reorg-mode');
      const data = await res.json();
      reorgModeActive = !!data.active;
    } catch (_) {
      reorgModeActive = false;
    }
    updateReorgModeUI();
  }

  async function toggleReorgMode() {
    const next = !reorgModeActive;
    try {
      // anchor / reorgNew を正しく確定させるため、切替前に現在の内容を保存
      syncAllFromDOM();
      await saveContent({ force: true, skipToast: true });
      const res = await fetch('/api/reorg-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: next })
      });
      const data = await res.json();
      if (data && data.ok) {
        reorgModeActive = !!data.active;
        updateReorgModeUI();
        await refreshTodaySections();
        showToast(reorgModeActive
          ? '整理モード ON：この間の変更は本日更新に出ません'
          : '整理モード OFF：整理分をベースラインに取り込みました', 2400);
      } else {
        showToast('整理モードの切替に失敗しました', 2200);
      }
    } catch (err) {
      showToast(`整理モード切替失敗: ${err.message}`, 2500);
    }
  }

  async function performUndo() {
    const res = await fetch('/api/undo', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      clearSelectedBlocks({ skipUiSync: true });
      armHistoryShortcut('redo');
      content = normalizeContentData(data.content);
      lastSavedContentJson = serializeContentForSave();
      lastSavedAt = new Date();
      startAutosave();
      refreshSaveStatus();
      render();
      showToast('元に戻しました', 1200);
    }
    updateUndoRedoButtons();
  }

  async function performRedo() {
    const res = await fetch('/api/redo', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      clearSelectedBlocks({ skipUiSync: true });
      armHistoryShortcut('undo');
      content = normalizeContentData(data.content);
      lastSavedContentJson = serializeContentForSave();
      lastSavedAt = new Date();
      startAutosave();
      refreshSaveStatus();
      render();
      showToast('やり直しました', 1200);
    }
    updateUndoRedoButtons();
  }

  async function updateUndoRedoButtons() {
    try {
      const res = await fetch('/api/undo-status');
      const data = await res.json();
      const btnUndo = $('#btnUndo');
      const btnRedo = $('#btnRedo');
      if (btnUndo) btnUndo.disabled = data.undoLen === 0;
      if (btnRedo) btnRedo.disabled = data.redoLen === 0;
    } catch (_) {}
  }

  async function loadTodayDiff() {
    const res = await fetch('/api/today-diff');
    return res.json();
  }

  async function loadRangeDiff(from, to) {
    const res = await fetch(`/api/range-diff?from=${from}&to=${to}`);
    return res.json();
  }

  async function loadSnapshots() {
    const res = await fetch('/api/snapshots');
    return res.json();
  }

  async function loadLegacySnapshots() {
    const res = await fetch('/api/legacy-snapshots');
    return res.json();
  }

  async function loadLegacyRange(from, to) {
    const res = await fetch(`/api/legacy-range?from=${from}&to=${to}`);
    return res.json();
  }

  // ============================================================
  //  Block operations (on content.blocks or section.children)
  // ============================================================

  function findBlockList(blockId, blocks) {
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].id === blockId) return { list: blocks, index: i };
      if (blocks[i].type === 'section' && blocks[i].children) {
        const result = findBlockList(blockId, blocks[i].children);
        if (result) return result;
      }
    }
    return null;
  }

  function deleteBlock(blockId) {
    const found = findBlockList(blockId, content.blocks);
    if (found) found.list.splice(found.index, 1);
  }

  function focusEditableBlock(blockId) {
    if (!blockId) return false;
    const targetEl = document.getElementById(`block-${blockId}`);
    if (!targetEl) return false;
    const editableEl = targetEl.querySelector('[contenteditable]') || targetEl.querySelector('textarea');
    if (!editableEl) return false;
    focusEditableHistoryTarget(editableEl);
    return true;
  }

  function removeBlockAndPersist(blockId, options) {
    const opts = options || {};
    const requestedBlockIds = Array.isArray(blockId) ? blockId : [blockId];
    const uniqueBlockIds = [...new Set(requestedBlockIds.filter(Boolean))];
    if (!uniqueBlockIds.length) return false;
    const undoSnapshotJson = serializeContentForSave();

    let focusTargetId = null;
    if (opts.focusAdjacent && uniqueBlockIds.length === 1) {
      const found = findBlockList(uniqueBlockIds[0], content.blocks);
      if (found && found.list.length > 1) {
        focusTargetId = found.index > 0
          ? found.list[found.index - 1]?.id
          : found.list[1]?.id;
      }
    }

    const validBlockIds = uniqueBlockIds.filter(currentBlockId => findBlockList(currentBlockId, content.blocks));
    if (!validBlockIds.length) return false;

    validBlockIds.forEach(currentBlockId => selectedBlockIds.delete(currentBlockId));
    validBlockIds.forEach(deleteBlock);
    armHistoryShortcut('undo');
    render();
    saveContent({
      reason: opts.reason,
      undoSnapshotJson,
      successMessage: opts.successMessage,
      successDuration: opts.successDuration
    });

    if (focusTargetId) {
      setTimeout(() => {
        focusEditableBlock(focusTargetId);
      }, 10);
    }

    return true;
  }

  function isBlockEmpty(block) {
    if (block.type === 'heading' || block.type === 'paragraph') {
      return !stripTags(block.text || '').trim();
    }
    if (block.type === 'code') {
      return !(block.content || '').trim();
    }
    if (block.type === 'section') {
      return !(block.title || '').trim() && (!block.children || block.children.length === 0);
    }
    if (block.type === 'image') {
      return !block.src;
    }
    if (block.type === 'table') {
      return false; // tables always confirm
    }
    return true;
  }

  function insertBlockAfter(blockId, newBlock, targetList) {
    const list = targetList || content.blocks;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === blockId) {
        list.splice(i + 1, 0, newBlock);
        return true;
      }
      if (list[i].type === 'section' && list[i].children) {
        if (insertBlockAfter(blockId, newBlock, list[i].children)) return true;
      }
    }
    return false;
  }

  function moveBlock(blockId, direction) {
    const found = findBlockList(blockId, content.blocks);
    if (!found) return;
    const { list, index } = found;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= list.length) return;
    [list[index], list[newIndex]] = [list[newIndex], list[index]];
  }

  // ============================================================
  //  Sync DOM → State
  // ============================================================

  function syncBlockFromDOM(blockEl) {
    const blockId = blockEl.dataset.blockId;
    const found = findBlockList(blockId, content.blocks);
    if (!found) return;
    const block = found.list[found.index];

    if (block.type === 'heading' || block.type === 'paragraph') {
      const ce = blockEl.querySelector('[contenteditable]');
      if (ce) block.text = normalizeEditableHtml(ce.innerHTML);
    } else if (block.type === 'code') {
      const ta = blockEl.querySelector('textarea');
      if (ta) block.content = ta.value;
      const sel = blockEl.querySelector('select');
      if (sel) block.language = sel.value;
    } else if (block.type === 'section') {
      const titleEl = blockEl.querySelector('.section-title');
      if (titleEl) block.title = titleEl.textContent;
      block.collapsed = blockEl.classList.contains('collapsed');
      // Sync children
      const body = blockEl.querySelector('.section-body');
      if (body) {
        const childEls = body.querySelectorAll(':scope > .block');
        childEls.forEach(childEl => syncBlockFromDOM(childEl));
      }
    } else if (block.type === 'table') {
      const ths = blockEl.querySelectorAll('th');
      const trs = blockEl.querySelectorAll('tbody tr');
      block.headers = Array.from(ths).map(th => th.textContent);
      block.rows = Array.from(trs).map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td => td.innerHTML)
      );
    }
  }

  function syncAllFromDOM() {
    const blockEls = blocksContainer.querySelectorAll(':scope > .block');
    blockEls.forEach(el => syncBlockFromDOM(el));
  }

  function startAutosave() {
    if (autosaveTimerId) clearInterval(autosaveTimerId);
    autosaveTimerId = setInterval(async () => {
      if (isViewMode || saveInFlight) return;
      syncAllFromDOM();
      if (!hasUnsavedChanges()) return;
      await saveContent({ reason: 'autosave' });
    }, getAutosaveIntervalMs());
  }

  // ── 別PCの更新をOneDrive経由で検知して自動反映する仕組み ──
  async function fetchSyncStatus() {
    try {
      const res = await fetch('/api/sync-status');
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }

  // 「今の共有データの版」を自分の基準として覚え直す（自分の保存を別PC扱いしないため）
  async function refreshSyncBaseline() {
    const st = await fetchSyncStatus();
    if (st) knownContentVersion = st.version;
  }

  // 別PCの内容を読み込み直して画面に反映（スクロール位置・モードは維持）
  async function reloadFromServer() {
    await loadContent();
    lastSavedContentJson = serializeContentForSave();
    setMode(isViewMode);          // render() を含む（スクロール維持）
    updateUndoRedoButtons();
    renderStickyNotes();
    refreshSaveStatus();
    await refreshTodaySections();
    await refreshSyncBaseline();
  }

  function startSyncWatch() {
    if (syncWatchTimerId) clearInterval(syncWatchTimerId);
    syncWatchTimerId = setInterval(checkForExternalChanges, 5000);
  }

  async function checkForExternalChanges() {
    if (saveInFlight) return;
    if (Date.now() - lastLocalSaveAt < 4000) return;   // 自分の保存直後は誤検知を避ける
    const st = await fetchSyncStatus();
    if (!st) return;
    if (knownContentVersion === null) { knownContentVersion = st.version; return; }
    if (st.version === knownContentVersion) return;

    // ここに来たら別PCが content.json を更新した
    if (hasUnsavedChanges()) {
      showExternalChangeBanner(st.version);            // 編集中なので勝手に上書きしない
    } else {
      await reloadFromServer();
      showToast('他のPCの変更を反映しました', 2500);
    }
  }

  function showExternalChangeBanner(newVersion) {
    if (externalChangeBannerEl) { externalChangeBannerEl.dataset.version = newVersion; return; }
    const bar = document.createElement('div');
    bar.dataset.version = newVersion;
    bar.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:99999;'
      + 'background:#b45309;color:#fff;padding:10px 14px;border-radius:10px;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.35);font-size:14px;display:flex;gap:10px;align-items:center;';
    const msg = document.createElement('span');
    msg.textContent = '他のPCで更新がありました。';
    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = '読み込む（この編集を破棄）';
    reloadBtn.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:5px 10px;background:#fff;color:#b45309;font-weight:bold;';
    reloadBtn.addEventListener('click', async () => {
      dismissExternalChangeBanner();
      await reloadFromServer();
      showToast('他のPCの変更を反映しました', 2500);
    });
    const keepBtn = document.createElement('button');
    keepBtn.textContent = 'このまま続ける';
    keepBtn.style.cssText = 'cursor:pointer;border:1px solid #fff;border-radius:6px;padding:5px 10px;background:transparent;color:#fff;';
    keepBtn.addEventListener('click', () => {
      knownContentVersion = bar.dataset.version;   // 以後この版は通知しない（次の保存で自分の内容が優先）
      dismissExternalChangeBanner();
    });
    bar.append(msg, reloadBtn, keepBtn);
    document.body.appendChild(bar);
    externalChangeBannerEl = bar;
  }

  function dismissExternalChangeBanner() {
    if (externalChangeBannerEl) { externalChangeBannerEl.remove(); externalChangeBannerEl = null; }
  }

  // ============================================================
  //  Rendering
  // ============================================================

  // ── Shared image-paste handler (used by each contenteditable block) ──
  function handleImagePaste(e, block) {
    // Try both clipboardData.items and clipboardData.files
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);

    // Collect image candidates
    let imageFile = null;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        imageFile = item.getAsFile();
        break;
      }
    }
    if (!imageFile) {
      for (const f of files) {
        if (f.type.startsWith('image/')) { imageFile = f; break; }
      }
    }
    if (!imageFile) return; // no image — let default paste proceed

    e.preventDefault();
    e.stopPropagation();
    const reader = new FileReader();
    reader.onload = (evt) => {
      syncAllFromDOM();
      const undoSnapshotJson = serializeContentForSave();
      const newBlock = { id: uid(), type: 'image', src: evt.target.result, alt: '', addedDate: todayStr() };
      if (block) {
        insertBlockAfter(block.id, newBlock);
      } else {
        content.blocks.push(newBlock);
      }
      render();
      saveContent({ undoSnapshotJson });
      showToast('画像を貼り付けました', 1500);
    };
    reader.readAsDataURL(imageFile);
  }

  function buildReadonlyBlockEl(block, options) {
    const expandedCodeIds = options.expandedCodeIds;
    const todayPreviewByBlockId = options.todayPreviewByBlockId || {};
    const renderChildBlock = options.renderChildBlock;
    const onPreviewNavigate = options.onPreviewNavigate || ((ctx) => {
      revealBlockTarget(ctx.sectionEl);
    });
    const onSectionToggled = options.onSectionToggled || (() => {});
    const highlightCode = options.highlightCode || (() => {});

    const el = document.createElement('div');
    el.className = 'block';
    el.dataset.blockId = block.id;
    el.id = `block-${block.id}`;

    if (block.type === 'heading') {
      el.classList.add('block-heading', `level-${block.level || 1}`);
      const heading = document.createElement('div');
      heading.contentEditable = 'false';
      heading.innerHTML = block.text || '';
      el.appendChild(heading);
      return el;
    }

    if (block.type === 'paragraph') {
      el.classList.add('block-paragraph');
      if (block.indent) el.classList.add(`indent-${block.indent}`);
      const paragraph = document.createElement('div');
      paragraph.contentEditable = 'false';
      paragraph.innerHTML = block.text || '';
      el.appendChild(paragraph);
      return el;
    }

    if (block.type === 'code') {
      el.classList.add('block-code');
      if (!expandedCodeIds.has(block.id)) el.classList.add('code-collapsed');

      if (block.language) {
        const header = document.createElement('div');
        header.className = 'code-header';
        header.textContent = block.language;
        el.appendChild(header);
      }

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = block.content || '';
      highlightCode(code, block.language || '');
      pre.appendChild(code);
      pre.addEventListener('click', () => {
        el.classList.toggle('code-collapsed');
        if (el.classList.contains('code-collapsed')) expandedCodeIds.delete(block.id);
        else expandedCodeIds.add(block.id);
      });
      el.appendChild(pre);
      return el;
    }

    if (block.type === 'table') {
      el.classList.add('block-table');
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      (block.headers || []).forEach(headerCell => {
        const th = document.createElement('th');
        th.contentEditable = 'false';
        th.textContent = headerCell;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      (block.rows || []).forEach(row => {
        const tr = document.createElement('tr');
        row.forEach(cell => {
          const td = document.createElement('td');
          td.contentEditable = 'false';
          td.innerHTML = cell;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      el.appendChild(table);
      return el;
    }

    if (block.type === 'image') {
      el.classList.add('block-image');
      const img = document.createElement('img');
      img.src = block.src || '';
      img.alt = block.alt || '';
      img.className = 'block-image-content';
      img.addEventListener('click', () => {
        img.classList.toggle('block-image-fullsize');
      });
      el.appendChild(img);
      return el;
    }

    if (block.type === 'section') {
      el.classList.add('block-section');
      if (block.collapsed) el.classList.add('collapsed');
      if (block.size === 'small') el.classList.add('section-small');

      // 背景部分（子ブロック以外）の右クリックで、このセクション内の見出し一覧＋ジャンプメニュー
      el.addEventListener('contextmenu', function(e) {
        if (e.target.closest('[contenteditable="true"], textarea, input')) return;
        if (e.target.closest('.block') !== el) return;
        var headings = (block.children || []).filter(function(c) { return c.type === 'heading'; });
        if (!headings.length) return;
        e.preventDefault();
        showHeadingJumpMenu(e, headings);
      });

      const sectionHeader = document.createElement('div');
      sectionHeader.className = 'section-header';

      const toggle = document.createElement('span');
      toggle.className = 'toggle-icon';
      toggle.textContent = '▼';
      sectionHeader.appendChild(toggle);

      const title = document.createElement('span');
      title.className = 'section-title';
      title.contentEditable = 'false';
      title.textContent = block.title || '';
      sectionHeader.appendChild(title);

      const badge = document.createElement('span');
      badge.className = 'section-badge';
      badge.textContent = `(${(block.children || []).length} 件)`;
      sectionHeader.appendChild(badge);

      sectionHeader.addEventListener('click', (e) => {
        if (title.contains(e.target)) return;
        const isCollapsed = el.classList.toggle('collapsed');
        block.collapsed = isCollapsed;
        onSectionToggled(block, el, isCollapsed);
      });
      el.appendChild(sectionHeader);

      const preview = document.createElement('div');
      preview.className = 'section-preview';
      const previewData = todayPreviewByBlockId[block.id];
      if (previewData && Array.isArray(previewData.lines) && previewData.lines.length) {
        el.classList.add('has-today-preview');
        previewData.lines.forEach(line => {
          const lineEl = document.createElement('div');
          lineEl.className = 'section-preview-line';
          lineEl.textContent = line;
          preview.appendChild(lineEl);
        });
        preview.addEventListener('click', () => {
          block.collapsed = false;
          el.classList.remove('collapsed');
          onPreviewNavigate({ targetBlockId: previewData.targetBlockId || block.id, sectionEl: el, block });
        });
      }
      el.appendChild(preview);

      const body = document.createElement('div');
      body.className = 'section-body';
      (block.children || []).forEach(child => {
        body.appendChild(renderChildBlock(child));
      });
      el.appendChild(body);
    }

    return el;
  }

  function buildNavigationTree(blocks, options) {
    const fragment = document.createDocumentFragment();
    const isSectionCollapsed = options.isSectionCollapsed || (() => false);
    const getHeadingText = options.getHeadingText || (() => '(無題)');
    const onSectionToggle = options.onSectionToggle || (() => {});
    const onSectionClick = options.onSectionClick || (() => {});
    const onSubheadingClick = options.onSubheadingClick || (() => {});
    const onHeadingClick = options.onHeadingClick || (() => {});

    (blocks || []).forEach(block => {
      if (block.type === 'section') {
        const li = document.createElement('li');
        li.className = 'nav-item nav-section';
        li.dataset.sectionId = block.id;
        if (block.size === 'small') li.classList.add('nav-section-small');
        if (isSectionCollapsed(block.id, block)) li.classList.add('nav-collapsed');

        const header = document.createElement('div');
        header.className = 'nav-section-header';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'nav-section-toggle';
        toggle.setAttribute('aria-label', 'セクションを折りたたみ');
        toggle.textContent = '▼';
        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const isCollapsed = li.classList.toggle('nav-collapsed');
          onSectionToggle({ block, navSectionEl: li, isCollapsed, event: e });
        });
        header.appendChild(toggle);

        const link = document.createElement('a');
        link.className = 'nav-section-link';
        link.href = `#block-${block.id}`;
        link.textContent = block.title || '(無題)';
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = `(${(block.children || []).length})`;
        link.appendChild(badge);
        link.addEventListener('click', (e) => {
          e.preventDefault();
          onSectionClick({ block, link, navSectionEl: li, event: e });
        });
        header.appendChild(link);
        li.appendChild(header);

        const body = document.createElement('ul');
        body.className = 'nav-section-body';
        (block.children || []).forEach(child => {
          if (child.type !== 'heading') return;

          const subLi = document.createElement('li');
          subLi.className = 'nav-item sub';
          const subLink = document.createElement('a');
          subLink.href = `#block-${child.id}`;
          subLink.textContent = getHeadingText(child);
          subLink.addEventListener('click', (e) => {
            e.preventDefault();
            onSubheadingClick({ block, child, link: subLink, navSectionEl: li, event: e });
          });
          subLi.appendChild(subLink);
          body.appendChild(subLi);
        });
        li.appendChild(body);
        fragment.appendChild(li);
        return;
      }

      if (block.type === 'heading') {
        const li = document.createElement('li');
        li.className = 'nav-item';
        const link = document.createElement('a');
        link.href = `#block-${block.id}`;
        link.textContent = getHeadingText(block);
        link.addEventListener('click', (e) => {
          e.preventDefault();
          onHeadingClick({ block, link, event: e });
        });
        li.appendChild(link);
        fragment.appendChild(li);
      }
    });

    return fragment;
  }

  function createNavigationInteractionHandlers(options) {
    const activateLink = options && options.activateLink ? options.activateLink : () => {};
    const getTarget = options && options.getTarget ? options.getTarget : (blockId) => document.getElementById(`block-${blockId}`);
    const jumpToBlock = options && options.jumpToBlock ? options.jumpToBlock : null;
    const expandNavSectionOnChildClick = !!(options && options.expandNavSectionOnChildClick);
    const childScrollDelayMs = options && typeof options.childScrollDelayMs === 'number' ? options.childScrollDelayMs : 0;
    const onSectionExpanded = options && options.onSectionExpanded ? options.onSectionExpanded : (block) => {
      if (block) block.collapsed = false;
    };

    return {
      onSectionClick: ({ block, link }) => {
        if (typeof jumpToBlock === 'function') {
          if (jumpToBlock(block.id, { expandTargetSection: false })) activateLink(link);
          return;
        }
        const target = getTarget(block.id);
        if (revealBlockTarget(target, { expandTargetSection: false })) activateLink(link);
      },
      onSubheadingClick: ({ block, child, link, navSectionEl }) => {
        if (expandNavSectionOnChildClick && navSectionEl) navSectionEl.classList.remove('nav-collapsed');

        if (typeof jumpToBlock === 'function') {
          if (jumpToBlock(child.id)) activateLink(link);
          return;
        }

        const sectionEl = getTarget(block.id);
        if (sectionEl && sectionEl.classList.contains('collapsed')) {
          sectionEl.classList.remove('collapsed');
          onSectionExpanded(block, sectionEl);
        }

        const scrollToChild = () => {
          const target = getTarget(child.id);
          if (revealBlockTarget(target)) activateLink(link);
        };

        if (childScrollDelayMs > 0) {
          setTimeout(scrollToChild, childScrollDelayMs);
          return;
        }

        scrollToChild();
      },
      onHeadingClick: ({ block, link }) => {
        if (typeof jumpToBlock === 'function') {
          if (jumpToBlock(block.id)) activateLink(link);
          return;
        }
        const target = getTarget(block.id);
        if (revealBlockTarget(target)) activateLink(link);
      }
    };
  }

  function renderNavigationList(navRoot, blocks, options) {
    if (!navRoot) return null;
    navRoot.innerHTML = '';
    const tree = buildNavigationTree(blocks, options);
    navRoot.appendChild(tree);
    return tree;
  }

  function renderViewerNavigation(navRoot, blocks, options) {
    if (options && typeof options.beforeRender === 'function') options.beforeRender();

    const navInteractions = createNavigationInteractionHandlers({
      activateLink: options && options.activateLink,
      getTarget: options && options.getTarget,
      jumpToBlock: options && options.jumpToBlock,
      expandNavSectionOnChildClick: !!(options && options.expandNavSectionOnChildClick),
      childScrollDelayMs: options && options.childScrollDelayMs,
      onSectionExpanded: options && options.onSectionExpanded
    });

    return renderNavigationList(navRoot, blocks, {
      isSectionCollapsed: options && options.isSectionCollapsed,
      getHeadingText: options && options.getHeadingText,
      onSectionToggle: options && options.onSectionToggle,
      onSectionClick: navInteractions.onSectionClick,
      onSubheadingClick: navInteractions.onSubheadingClick,
      onHeadingClick: navInteractions.onHeadingClick
    });
  }

  function createViewerNavigationRenderer(options) {
    const navigationOptions = options || {};
    return function() {
      if (typeof navigationOptions.beforeInvoke === 'function') navigationOptions.beforeInvoke();

      const navRoot = typeof navigationOptions.getNavRoot === 'function'
        ? navigationOptions.getNavRoot()
        : navigationOptions.navRoot;
      const blocks = typeof navigationOptions.getBlocks === 'function'
        ? navigationOptions.getBlocks()
        : navigationOptions.blocks;

      return renderViewerNavigation(navRoot, blocks, {
        beforeRender: navigationOptions.beforeRender,
        activateLink: navigationOptions.activateLink,
        getTarget: navigationOptions.getTarget,
        jumpToBlock: navigationOptions.jumpToBlock,
        expandNavSectionOnChildClick: !!navigationOptions.expandNavSectionOnChildClick,
        childScrollDelayMs: navigationOptions.childScrollDelayMs,
        onSectionExpanded: navigationOptions.onSectionExpanded,
        isSectionCollapsed: navigationOptions.isSectionCollapsed,
        getHeadingText: navigationOptions.getHeadingText,
        onSectionToggle: navigationOptions.onSectionToggle
      });
    };
  }

  function autoScrollNavWithin(navScroller, link) {
    if (!navScroller || !link) return;
    const linkRect = link.getBoundingClientRect();
    const navRect = navScroller.getBoundingClientRect();
    if (linkRect.top < navRect.top + 40 || linkRect.bottom > navRect.bottom - 40) {
      link.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function getCollapsedAwareNavLink(link) {
    if (!link) return null;
    const navSection = link.closest('.nav-section.nav-collapsed');
    if (!navSection) return link;
    return navSection.querySelector('.nav-section-link') || link;
  }

  function setActiveNavLinkState(navRoot, activeLink, options) {
    const links = navRoot ? navRoot.querySelectorAll('a') : [];
    links.forEach(link => link.classList.remove('active'));

    const linkToHighlight = getCollapsedAwareNavLink(activeLink);
    if (!linkToHighlight) return null;

    linkToHighlight.classList.add('active');
    autoScrollNavWithin(options && options.navScroller, linkToHighlight);
    if (options && typeof options.onActivated === 'function') options.onActivated(linkToHighlight);
    return linkToHighlight;
  }

  function activateNavLinkWithSuppression(state, navRoot, activeLink, options) {
    const suppressionMs = options && typeof options.suppressionMs === 'number' ? options.suppressionMs : 800;
    const linkToHighlight = setActiveNavLinkState(navRoot, activeLink, options);
    if (!linkToHighlight || !state) return linkToHighlight;
    state.scrollSpySuppressed = true;
    clearTimeout(state.scrollSpyTimer);
    state.scrollSpyTimer = setTimeout(() => {
      state.scrollSpySuppressed = false;
    }, suppressionMs);
    return linkToHighlight;
  }

  function createNavLinkActivator(state, navRoot, navScroller, options) {
    const activatorOptions = options || {};
    return function(activeLink) {
      return activateNavLinkWithSuppression(state, navRoot, activeLink, {
        navScroller,
        suppressionMs: activatorOptions.suppressionMs
      });
    };
  }

  function buildStickyNoteElement(note, options) {
    const isToday = !!(options && options.isToday);
    const el = document.createElement('div');
    el.className = 'sticky-note' + (isToday ? ' sticky-today' : '');
    el.style.backgroundColor = note.color;

    if (isToday) {
      el.dataset.stickyType = 'today';
      const label = document.createElement('div');
      label.className = 'sticky-today-label';
      label.textContent = 'TODAY';
      el.appendChild(label);
    } else if (note.targetBlockId) {
      el.dataset.blockId = note.targetBlockId;
    }

    const text = document.createElement('span');
    text.textContent = note.text;
    el.appendChild(text);

    const titleText = options && typeof options.getTitle === 'function'
      ? options.getTitle({ note, isToday })
      : options && options.titleText;
    if (titleText) el.title = titleText;

    if (options && typeof options.onActivate === 'function') {
      el.addEventListener('click', (event) => {
        if (typeof options.shouldActivate === 'function' && options.shouldActivate({ event, el, note, isToday }) === false) {
          return;
        }
        options.onActivate({ event, el, note, isToday });
      });
    }

    return el;
  }

  function activateStickyNavigation(note, options) {
    if (options && options.isToday) {
      const todayMainId = options.getTodayMainId ? options.getTodayMainId() : null;
      if (!todayMainId || !options.scrollToTodayMain) return false;
      return !!options.scrollToTodayMain(todayMainId);
    }

    if (!note || !note.targetBlockId || !options || !options.jumpToBlock) return false;
    return !!options.jumpToBlock(note.targetBlockId);
  }

  function createStickyActivationHandler(note, options) {
    const activationOptions = options || {};
    return function() {
      if (activationOptions.isToday) {
        activateStickyNavigation(note, {
          isToday: true,
          getTodayMainId: activationOptions.getTodayMainId,
          scrollToTodayMain: activationOptions.scrollToTodayMain
        });
        return;
      }

      if (!activateStickyNavigation(note, { jumpToBlock: activationOptions.jumpToBlock })) {
        if (typeof activationOptions.onMiss === 'function') activationOptions.onMiss();
      }
    };
  }

  function buildStickyNotesFragment(stickyNotes, options) {
    const fragment = document.createDocumentFragment();
    const notes = Array.isArray(stickyNotes) ? stickyNotes : [];

    notes.forEach(note => {
      fragment.appendChild(options.buildSticky(note, false));
    });

    if (notes.length > 0) {
      const separator = document.createElement('hr');
      separator.className = 'sticky-separator';
      fragment.appendChild(separator);
    }

    fragment.appendChild(options.buildSticky({
      id: '__today__',
      text: '本日更新セクション',
      color: options.todayColor || '#339af0',
      targetBlockId: null,
      isToday: true
    }, true));

    return fragment;
  }

  function renderStickyNotesList(container, stickyNotes, options) {
    if (!container) return null;
    container.innerHTML = '';
    const fragment = buildStickyNotesFragment(stickyNotes, options);
    container.appendChild(fragment);
    return fragment;
  }

  function createStickyNotesRenderer(options) {
    const stickyOptions = options || {};
    return function() {
      if (typeof stickyOptions.beforeRender === 'function') stickyOptions.beforeRender();

      const container = typeof stickyOptions.getContainer === 'function'
        ? stickyOptions.getContainer()
        : stickyOptions.container;
      const stickyNotes = typeof stickyOptions.getStickyNotes === 'function'
        ? stickyOptions.getStickyNotes()
        : stickyOptions.stickyNotes;
      const todayColor = typeof stickyOptions.getTodayColor === 'function'
        ? stickyOptions.getTodayColor()
        : stickyOptions.todayColor;

      return renderStickyNotesList(container, stickyNotes, {
        todayColor,
        buildSticky: stickyOptions.buildSticky
      });
    };
  }

  function bindViewerUtilityButtons(options) {
    const utilityOptions = options || {};
    if (utilityOptions.themeButton && typeof utilityOptions.onThemeToggle === 'function') {
      utilityOptions.themeButton.addEventListener('click', utilityOptions.onThemeToggle);
    }
    if (utilityOptions.topButton) {
      utilityOptions.topButton.addEventListener('click', utilityOptions.onScrollTop || scrollToPageTop);
    }
  }

  function scrollToPageTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function createAnimationFrameThrottledHandler(handler) {
    let ticking = false;
    return function() {
      if (ticking || typeof handler !== 'function') return;
      ticking = true;
      requestAnimationFrame(() => {
        try {
          handler();
        } finally {
          ticking = false;
        }
      });
    };
  }

  function bindViewerScrollHandlers(options) {
    const scrollOptions = options || {};
    if (typeof scrollOptions.onScrollSpy === 'function') {
      const scrollSpyHandler = scrollOptions.throttleScrollSpyWithAnimationFrame
        ? createAnimationFrameThrottledHandler(scrollOptions.onScrollSpy)
        : scrollOptions.onScrollSpy;
      window.addEventListener('scroll', scrollSpyHandler, { passive: true });
    }
    if (typeof scrollOptions.onScrollTop === 'function') {
      window.addEventListener('scroll', scrollOptions.onScrollTop, { passive: true });
    }
  }

  function createScrollTopButtonUpdater(button) {
    return function() {
      setScrollTopButtonVisible(button, window.scrollY > 260);
    };
  }

  function updateThemeToggleButton(button, isLightMode, getIconHtml) {
    if (!button) return;
    button.innerHTML = typeof getIconHtml === 'function' ? getIconHtml(isLightMode) : '';
    button.title = isLightMode ? 'ダークモードに切り替え' : 'ライトモードに切り替え';
  }

  function setScrollTopButtonVisible(button, shouldShow) {
    if (!button) return;
    button.classList.toggle('show', !!shouldShow);
  }

  function isTargetHiddenInCollapsedSection(target) {
    return !!(target && target.closest && target.closest('.block-section.collapsed > .section-body'));
  }

  function findScrollSpyActiveLink(navRoot, options) {
    const links = navRoot ? navRoot.querySelectorAll('a') : [];
    if (!links.length) return null;

    const scrollY = options && typeof options.scrollY === 'number' ? options.scrollY : window.scrollY;
    const viewHeight = options && typeof options.viewHeight === 'number' ? options.viewHeight : window.innerHeight;
    const docHeight = options && typeof options.docHeight === 'number' ? options.docHeight : document.documentElement.scrollHeight;
    const triggerRatio = options && typeof options.triggerRatio === 'number' ? options.triggerRatio : 0.2;
    const bottomThreshold = options && typeof options.bottomThreshold === 'number' ? options.bottomThreshold : 30;
    const shouldSkipTarget = options && typeof options.shouldSkipTarget === 'function'
      ? options.shouldSkipTarget
      : (target) => isTargetHiddenInCollapsedSection(target);

    if (scrollY + viewHeight >= docHeight - bottomThreshold) {
      return links[links.length - 1] || null;
    }

    const triggerY = scrollY + viewHeight * triggerRatio;
    let activeLink = null;

    links.forEach(link => {
      const targetId = link.getAttribute('href')?.replace('#', '');
      const target = targetId ? document.getElementById(targetId) : null;
      if (!target || shouldSkipTarget(target, link)) return;

      const top = target.getBoundingClientRect().top + scrollY;
      if (top <= triggerY) activeLink = link;
    });

    return activeLink;
  }

  function updateStandardNavScrollSpy(navRoot, options) {
    if (!navRoot || (options && options.isSuppressed)) return null;

    const navScroller = options && options.navScroller;
    if (!(options && options.skipClear)) {
      setActiveNavLinkState(navRoot, null, { navScroller });
      if (options && typeof options.onAfterClear === 'function') options.onAfterClear();
    }

    if (options && options.clearOnly) return null;

    const activeLink = findScrollSpyActiveLink(navRoot, {
      scrollY: options && options.scrollY,
      viewHeight: options && options.viewHeight,
      docHeight: options && options.docHeight,
      triggerRatio: options && options.triggerRatio,
      bottomThreshold: options && options.bottomThreshold,
      shouldSkipTarget: options && options.shouldSkipTarget
    });

    if (!activeLink) return null;
    return setActiveNavLinkState(navRoot, activeLink, { navScroller });
  }

  function createStandardNavScrollSpyUpdater(options) {
    const defaultOptions = options || {};
    return function(overrideOptions) {
      const mergedOptions = { ...defaultOptions, ...(overrideOptions || {}) };
      const navRoot = typeof mergedOptions.getNavRoot === 'function' ? mergedOptions.getNavRoot() : mergedOptions.navRoot;
      const navScroller = typeof mergedOptions.getNavScroller === 'function' ? mergedOptions.getNavScroller() : mergedOptions.navScroller;
      const isSuppressed = typeof mergedOptions.getIsSuppressed === 'function' ? mergedOptions.getIsSuppressed() : mergedOptions.isSuppressed;
      const scrollY = typeof mergedOptions.getScrollY === 'function' ? mergedOptions.getScrollY() : mergedOptions.scrollY;
      const viewHeight = typeof mergedOptions.getViewHeight === 'function' ? mergedOptions.getViewHeight() : mergedOptions.viewHeight;
      const docHeight = typeof mergedOptions.getDocHeight === 'function' ? mergedOptions.getDocHeight() : mergedOptions.docHeight;

      return updateStandardNavScrollSpy(navRoot, {
        isSuppressed,
        navScroller,
        skipClear: mergedOptions.skipClear,
        clearOnly: mergedOptions.clearOnly,
        onAfterClear: mergedOptions.onAfterClear,
        shouldSkipTarget: mergedOptions.shouldSkipTarget,
        triggerRatio: mergedOptions.triggerRatio,
        bottomThreshold: mergedOptions.bottomThreshold,
        scrollY,
        viewHeight,
        docHeight
      });
    };
  }

  function flashElement(el) {
    if (!el) return false;
    el.classList.add('highlight-flash');
    setTimeout(() => el.classList.remove('highlight-flash'), 1500);
    return true;
  }

  function expandCollapsedSectionAncestors(target, onExpanded, options) {
    const expansionOptions = options || {};
    let parent = null;
    if (target && target.closest) {
      parent = expansionOptions.expandTargetSection
        ? target.closest('.block-section.collapsed')
        : target.parentElement?.closest('.block-section.collapsed');
    }
    while (parent) {
      parent.classList.remove('collapsed');
      if (typeof onExpanded === 'function') onExpanded(parent.dataset.blockId, parent);
      parent = parent.parentElement?.closest('.block-section.collapsed');
    }
  }

  function revealBlockTarget(target, options) {
    if (!target) return false;
    const revealOptions = options || {};
    expandCollapsedSectionAncestors(target, revealOptions.onExpanded, {
      expandTargetSection: !Object.prototype.hasOwnProperty.call(revealOptions, 'expandTargetSection') || !!revealOptions.expandTargetSection
    });
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flashElement(target);
    return true;
  }

  function revealTodayTarget(target, todayContainer) {
    if (!target || !todayContainer) return false;
    if (todayContainer.style.display === 'none') todayContainer.style.display = '';
    todayContainer.classList.remove('today-collapsed');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flashElement(target);
    return true;
  }

  function createViewerJumpHandlers(options) {
    const jumpOptions = options || {};
    const getBlockTarget = jumpOptions.getBlockTarget || ((blockId) => document.getElementById(`block-${blockId}`));

    return {
      jumpToBlock(blockId, options) {
        const target = getBlockTarget(blockId);
        if (!target) return false;
        const jumpCallOptions = options || {};
        return revealBlockTarget(target, {
          onExpanded: jumpOptions.onExpanded,
          expandTargetSection: !Object.prototype.hasOwnProperty.call(jumpCallOptions, 'expandTargetSection') || !!jumpCallOptions.expandTargetSection
        });
      },
      scrollToTodayMain(id) {
        const target = document.getElementById(id);
        return revealTodayTarget(target, jumpOptions.todayContainer);
      }
    };
  }

  function exposeViewerJumpHandlers(options) {
    const jumpOptions = options || {};
    if (typeof jumpOptions.jumpToBlock === 'function') window.jumpToBlock = jumpOptions.jumpToBlock;
    if (typeof jumpOptions.scrollToTodayMain === 'function') window.scrollToTodayMain = jumpOptions.scrollToTodayMain;
  }

  function normalizeHighlightLanguage(language) {
    const langMap = { vb: 'vbnet', csharp: 'csharp' };
    return langMap[language] || language || '';
  }

  function getHighlightLanguageClass(language) {
    const normalized = normalizeHighlightLanguage(language);
    return normalized ? `language-${normalized}` : '';
  }

  function highlightCodeElement(codeEl, language) {
    if (!codeEl || !language || typeof hljs === 'undefined') return false;
    codeEl.className = getHighlightLanguageClass(language);
    try { hljs.highlightElement(codeEl); } catch (_) {}
    return true;
  }

  function renderDocumentStructure(options) {
    const blocks = Array.isArray(options && options.blocks) ? options.blocks : [];
    const container = options && options.blocksContainer;

    if (container) {
      container.innerHTML = '';
      blocks.forEach(block => {
        container.appendChild(options.renderBlock(block));
      });
    }

    if (options && typeof options.buildNavigation === 'function') options.buildNavigation();
    if (options && typeof options.renderTodaySections === 'function') options.renderTodaySections();
    if (options && typeof options.renderStickyNotes === 'function') options.renderStickyNotes();
  }

  function createDocumentStructureRenderer(options) {
    const structureOptions = options || {};
    return function() {
      return renderDocumentStructure({
        blocks: typeof structureOptions.getBlocks === 'function' ? structureOptions.getBlocks() : structureOptions.blocks,
        blocksContainer: typeof structureOptions.getBlocksContainer === 'function' ? structureOptions.getBlocksContainer() : structureOptions.blocksContainer,
        renderBlock: structureOptions.renderBlock,
        buildNavigation: structureOptions.buildNavigation,
        renderTodaySections: structureOptions.renderTodaySections,
        renderStickyNotes: structureOptions.renderStickyNotes
      });
    };
  }

  function createReadonlyTreeRenderer(options) {
    const readonlyOptions = options || {};
    const renderReadonlyTree = (currentBlock) => buildReadonlyBlockEl(currentBlock, {
      expandedCodeIds: readonlyOptions.expandedCodeIds,
      todayPreviewByBlockId: readonlyOptions.todayPreviewByBlockId || {},
      renderChildBlock: renderReadonlyTree,
      onPreviewNavigate: readonlyOptions.onPreviewNavigate,
      onSectionToggled: readonlyOptions.onSectionToggled,
      highlightCode: readonlyOptions.highlightCode || highlightCodeElement
    });
    return renderReadonlyTree;
  }

  function renderBlock(block, isEditable) {
    if (!isEditable) {
      const renderReadonlyTree = createReadonlyTreeRenderer({
        expandedCodeIds: expandedCodeBlockIds,
        todayPreviewByBlockId: {},
        onPreviewNavigate: ({ targetBlockId, sectionEl, block: sectionBlock }) => {
          jumpToBlock(targetBlockId || sectionBlock.id);
        },
        onSectionToggled: () => {
          refreshSaveStatus();
        },
        highlightCode: highlightCodeElement
      });
      return renderReadonlyTree(block);
    }

    const el = document.createElement('div');
    el.className = 'block';
    el.dataset.blockId = block.id;
    el.id = `block-${block.id}`;

    // Controls (edit mode)
    if (isEditable) {
      const controls = document.createElement('div');
      controls.className = 'block-controls';
      controls.innerHTML = `
        <button class="ctrl-up" title="上へ移動">↑</button>
        <button class="ctrl-down" title="下へ移動">↓</button>
        <button class="ctrl-select" title="選択" aria-pressed="false">□</button>
        <button class="ctrl-del" title="削除">✕</button>
      `;
      el.appendChild(controls);

      controls.querySelector('.ctrl-up').addEventListener('click', () => {
        syncAllFromDOM();
        const undoSnapshotJson = serializeContentForSave();
        moveBlock(block.id, -1);
        render();
        saveContent({ undoSnapshotJson });
      });
      controls.querySelector('.ctrl-down').addEventListener('click', () => {
        syncAllFromDOM();
        const undoSnapshotJson = serializeContentForSave();
        moveBlock(block.id, 1);
        render();
        saveContent({ undoSnapshotJson });
      });
      controls.querySelector('.ctrl-select').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSelectedBlock(block.id);
      });
      controls.querySelector('.ctrl-del').addEventListener('click', () => {
        syncAllFromDOM();
        const selectedIds = selectedBlockIds.has(block.id) ? getSelectedBlockIdsForDeletion() : [];
        const blockIdsToRemove = selectedIds.length > 1 ? selectedIds : [block.id];
        const deletedCount = blockIdsToRemove.length;
        removeBlockAndPersist(blockIdsToRemove, {
          successMessage: deletedCount > 1
            ? `${deletedCount}個のブロックを削除しました。Ctrl+Zで元に戻せます`
            : 'ブロックを削除しました。Ctrl+Zで元に戻せます',
          successDuration: 2200
        });
      });
    }

    if (block.type === 'heading') {
      el.classList.add('block-heading', `level-${block.level || 1}`);
      const ce = document.createElement('div');
      ce.contentEditable = isEditable ? 'true' : 'false';
      ce.innerHTML = isEditable ? renderEditableContentHtml(block.text || '') : (block.text || '');
      ce.addEventListener('keydown', (e) => handleBlockKeydown(e, block, el));
      if (isEditable) ce.addEventListener('paste', (e) => handleImagePaste(e, block));
      el.appendChild(ce);

    } else if (block.type === 'paragraph') {
      el.classList.add('block-paragraph');
      if (block.indent) el.classList.add(`indent-${block.indent}`);
      const ce = document.createElement('div');
      ce.contentEditable = isEditable ? 'true' : 'false';
      ce.innerHTML = isEditable ? renderEditableContentHtml(block.text || '') : (block.text || '');
      ce.addEventListener('keydown', (e) => handleBlockKeydown(e, block, el));
      if (isEditable) ce.addEventListener('paste', (e) => handleImagePaste(e, block));
      el.appendChild(ce);

    } else if (block.type === 'code') {
      el.classList.add('block-code');
      if (!expandedCodeBlockIds.has(block.id)) el.classList.add('code-collapsed');

      const expandCodeBlock = () => {
        if (!el.classList.contains('code-collapsed')) return;
        expandedCodeBlockIds.add(block.id);
        el.classList.remove('code-collapsed');
        const textarea = el.querySelector('textarea');
        if (textarea) {
          setTimeout(() => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
            textarea.focus();
          }, 0);
        }
      };

      if (isEditable) {
        const header = document.createElement('div');
        header.className = 'code-header';
        const langSelect = document.createElement('select');
        const langs = ['', 'sql', 'vb', 'javascript', 'python', 'csharp', 'html', 'css', 'json', 'powershell'];
        langs.forEach(l => {
          const opt = document.createElement('option');
          opt.value = l;
          opt.textContent = l || '言語なし';
          if (l === (block.language || '')) opt.selected = true;
          langSelect.appendChild(opt);
        });
        header.appendChild(langSelect);
        el.appendChild(header);

        header.addEventListener('click', (e) => {
          if (e.target.closest('select')) return;
          expandCodeBlock();
        });

        const ta = document.createElement('textarea');
        ta.value = block.content || '';
        ta.spellcheck = false;
        ta.addEventListener('input', () => {
          ta.style.height = 'auto';
          ta.style.height = ta.scrollHeight + 'px';
        });
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const start = ta.selectionStart;
            ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(ta.selectionEnd);
            ta.selectionStart = ta.selectionEnd = start + 4;
          }
          if ((e.key === 'Backspace' || e.key === 'Delete') && ta.value.trim() === '') {
            const found = findBlockList(block.id, content.blocks);
            if (found && found.list.length > 1) {
              e.preventDefault();
              syncAllFromDOM();
              removeBlockAndPersist(block.id, {
                focusAdjacent: true,
                successMessage: '空のコードブロックを削除しました',
                successDuration: 1200
              });
            }
          }
        });
        el.appendChild(ta);
        setTimeout(() => { ta.style.height = ta.scrollHeight + 'px'; }, 0);
        el.addEventListener('click', () => expandCodeBlock());
      } else {
        if (block.language) {
          const header = document.createElement('div');
          header.className = 'code-header';
          header.textContent = block.language;
          el.appendChild(header);
        }
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = block.content || '';
        highlightCodeElement(code, block.language);
        pre.appendChild(code);
        pre.addEventListener('click', () => {
          el.classList.toggle('code-collapsed');
          if (el.classList.contains('code-collapsed')) expandedCodeBlockIds.delete(block.id);
          else expandedCodeBlockIds.add(block.id);
        });
        el.appendChild(pre);
      }

    } else if (block.type === 'table') {
      el.classList.add('block-table');
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      (block.headers || []).forEach(h => {
        const th = document.createElement('th');
        th.contentEditable = isEditable ? 'true' : 'false';
        th.textContent = h;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      (block.rows || []).forEach(row => {
        const tr = document.createElement('tr');
        row.forEach(cell => {
          const td = document.createElement('td');
          td.contentEditable = isEditable ? 'true' : 'false';
          td.innerHTML = cell;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      el.appendChild(table);

      if (isEditable) {
        const controls = document.createElement('div');
        controls.className = 'table-controls';
        controls.innerHTML = `
          <button class="add-row">+行</button>
          <button class="add-col">+列</button>
          <button class="del-row">-行</button>
          <button class="del-col">-列</button>
        `;
        controls.querySelector('.add-row').addEventListener('click', () => {
          syncBlockFromDOM(el);
          const undoSnapshotJson = serializeContentForSave();
          const found = findBlockList(block.id, content.blocks);
          if (found) {
            const b = found.list[found.index];
            b.rows.push(new Array(b.headers.length).fill(''));
            render();
            saveContent({ undoSnapshotJson });
          }
        });
        controls.querySelector('.add-col').addEventListener('click', () => {
          syncBlockFromDOM(el);
          const undoSnapshotJson = serializeContentForSave();
          const found = findBlockList(block.id, content.blocks);
          if (found) {
            const b = found.list[found.index];
            b.headers.push('');
            b.rows.forEach(r => r.push(''));
            render();
            saveContent({ undoSnapshotJson });
          }
        });
        controls.querySelector('.del-row').addEventListener('click', () => {
          syncBlockFromDOM(el);
          const undoSnapshotJson = serializeContentForSave();
          const found = findBlockList(block.id, content.blocks);
          if (found) {
            const b = found.list[found.index];
            if (b.rows.length > 0) b.rows.pop();
            render();
            saveContent({ undoSnapshotJson });
          }
        });
        controls.querySelector('.del-col').addEventListener('click', () => {
          syncBlockFromDOM(el);
          const undoSnapshotJson = serializeContentForSave();
          const found = findBlockList(block.id, content.blocks);
          if (found) {
            const b = found.list[found.index];
            if (b.headers.length > 1) {
              b.headers.pop();
              b.rows.forEach(r => r.pop());
              render();
              saveContent({ undoSnapshotJson });
            }
          }
        });
        el.appendChild(controls);
      }

    } else if (block.type === 'image') {
      el.classList.add('block-image');
      const img = document.createElement('img');
      img.src = block.src || '';
      img.alt = block.alt || '';
      img.className = 'block-image-content';
      img.addEventListener('click', () => {
        // Click to toggle full-size view
        img.classList.toggle('block-image-fullsize');
      });
      el.appendChild(img);

    } else if (block.type === 'section') {
      el.classList.add('block-section');
      if (block.collapsed) el.classList.add('collapsed');
      if (block.size === 'small') el.classList.add('section-small');

      // 背景部分（段落など子ブロック以外）の右クリックで、このセクション内の見出し一覧＋ジャンプメニューを表示
      el.addEventListener('contextmenu', (e) => {
        if (e.target.closest('[contenteditable="true"], textarea, input')) return; // 編集テキスト上は通常の右クリックを優先
        if (e.target.closest('.block') !== el) return; // 子ブロック上ではなく、このセクションの背景のみ
        const headings = (block.children || []).filter(c => c.type === 'heading');
        if (!headings.length) return;
        e.preventDefault();
        showHeadingJumpMenu(e, headings);
      });

      const header = document.createElement('div');
      header.className = 'section-header';

      const toggle = document.createElement('span');
      toggle.className = 'toggle-icon';
      toggle.textContent = '▼';
      header.appendChild(toggle);

      const title = document.createElement('span');
      title.className = 'section-title';
      title.contentEditable = isEditable ? 'true' : 'false';
      title.textContent = block.title || '';
      title.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); }
      });
      header.appendChild(title);

      const badge = document.createElement('span');
      badge.className = 'section-badge';
      badge.textContent = `(${(block.children || []).length} 件)`;
      header.appendChild(badge);

      header.addEventListener('click', (e) => {
        // Only skip toggle when clicking directly on the editable title text
        if (title.contains(e.target)) return;
        el.classList.toggle('collapsed');
        block.collapsed = el.classList.contains('collapsed');
        refreshSaveStatus();
      });
      el.appendChild(header);

      // プレビュー（閉じた状態で本日更新分の冒頭を表示、addTodayPreviewsで中身を埋める）
      const preview = document.createElement('div');
      preview.className = 'section-preview';
      el.appendChild(preview);

      const body = document.createElement('div');
      body.className = 'section-body';
      (block.children || []).forEach(child => {
        body.appendChild(renderBlock(child, isEditable));
      });

      if (isEditable) {
        const addRow = document.createElement('div');
        addRow.className = 'add-block-row';
        const addBtn = document.createElement('button');
        addBtn.textContent = '+ 追加';
        addBtn.addEventListener('click', (e) => showAddMenu(e, block.children, block.id));
        addRow.appendChild(addBtn);
        body.appendChild(addRow);
      }

      el.appendChild(body);
    }

    return el;
  }

  // 本日更新行からプレビュー行を取得（コードフェンスやテーブルマーカーを除外）
  function getTodayPreviewLines(groups, sectionName, maxLines) {
    const lines = [];
    for (const group of groups) {
      if (group.section !== sectionName) continue;
      for (const item of group.items) {
        if (lines.length >= maxLines) break;
        if (/^```/.test(item)) continue;
        if (item === '|BLANK|' || item === '|PARAGRAPH_BREAK|' || item === '|TABLE_START|' || item === '|TABLE_END|') continue;
        const trimmed = normalizeTodayDisplayText(item).trim();
        if (trimmed) lines.push(trimmed);
      }
      if (lines.length >= maxLines) break;
    }
    return lines.slice(0, maxLines);
  }

  // Find the first paragraph block matching a today-updated item within a section's children.
  // Falls back to the heading block ID, then to null.
  function findFirstItemBlockId(subheadingText, items, blocks) {
    if (!subheadingText || !items || !items.length || !blocks || !blocks.length) return null;

    // Find the heading that matches the subheading
    let headingIdx = -1;
    let headingBlockId = null;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'heading') {
        const bText = stripTags(b.text || '');
        if (bText.includes(subheadingText) || subheadingText.includes(bText)) {
          headingIdx = i;
          headingBlockId = b.id;
          break;
        }
      }
      if (b.type === 'section' && b.children) {
        const found = findFirstItemBlockId(subheadingText, items, b.children);
        if (found) return found;
      }
    }

    if (headingIdx < 0) return null;

    // Get the first meaningful item text (skip code fences, markers)
    const firstItem = items.find(item => {
      if (/^```/.test(item)) return false;
      if (item === '|BLANK|' || item === '|PARAGRAPH_BREAK|' || item === '|TABLE_START|' || item === '|TABLE_END|') return false;
      return item.trim().length > 0;
    });
    if (!firstItem) return headingBlockId;

    // Strip tags and normalize for comparison
    const normalizedItem = firstItem.replace(/<[^>]+>/g, '').replace(/\u2003/g, '').replace(/&[^;]+;/g, '').trim();
    if (!normalizedItem) return headingBlockId;

    // Search blocks after the heading for a matching paragraph
    for (let i = headingIdx + 1; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'heading') break; // Stop at next heading
      if (b.type === 'paragraph') {
        const bText = stripTags(b.text || '').trim();
        if (bText && (bText.includes(normalizedItem) || normalizedItem.includes(bText))) {
          return b.id;
        }
      }
    }

    return headingBlockId;
  }

  function buildTodayPreviewMap(todayData, blocks) {
    const previews = {};
    if (!todayData || !Array.isArray(todayData.groups) || !todayData.groups.length) return previews;

    function visit(list) {
      for (const block of list || []) {
        if (block.type === 'section') {
          // 小セクション（軽量な折りたたみ）は「閉じたときの本日の更新プレビュー」を出さない
          if (block.size === 'small') {
            visit(block.children || []);
            continue;
          }
          const sectionName = (block.title || '').trim();
          const lines = sectionName ? getTodayPreviewLines(todayData.groups, sectionName, 4) : [];
          if (lines.length) {
            const firstGroup = todayData.groups.find(group => group.section === sectionName);
            let targetBlockId = block.id;
            if (firstGroup && firstGroup.subheading && Array.isArray(block.children)) {
              // Try to find the specific paragraph that was updated, falling back to heading, then section
              targetBlockId = findFirstItemBlockId(firstGroup.subheading, firstGroup.items, block.children)
                || findBlockIdByText(firstGroup.subheading, block.children)
                || block.id;
            }
            previews[block.id] = { lines, targetBlockId };
          }
          visit(block.children || []);
        }
      }
    }

    visit(blocks || content.blocks);
    return previews;
  }

  // 全セクションを閉じる
  function collapseAllSections(blocks) {
    for (const block of blocks) {
      if (block.type === 'section') {
        block.collapsed = true;
        if (block.children) collapseAllSections(block.children);
      }
    }
  }

  // 本日更新されたセクションにプレビューを表示
  function addTodayPreviews(todayData) {
    const previewMap = buildTodayPreviewMap(todayData, content.blocks);

    document.querySelectorAll('.block-section').forEach(sectionEl => {
      const blockId = sectionEl.dataset.blockId;
      const previewEl = sectionEl.querySelector('.section-preview');
      if (!previewEl || !blockId) return;

      previewEl.innerHTML = '';
      sectionEl.classList.remove('has-today-preview');

      const previewData = previewMap[blockId];
      if (!previewData || !Array.isArray(previewData.lines) || !previewData.lines.length) return;

      sectionEl.classList.add('has-today-preview');
      previewData.lines.forEach(line => {
        const p = document.createElement('div');
        p.className = 'section-preview-line';
        p.textContent = line;
        previewEl.appendChild(p);
      });

      previewEl.onclick = () => {
        jumpToBlock(previewData.targetBlockId || blockId);
      };
    });
  }

  function render() {
    applyDocumentMetadata();
    renderCurrentDocument();
    syncSelectedBlockState();
  }

  const renderCurrentDocument = createDocumentStructureRenderer({
    getBlocks: () => content.blocks,
    blocksContainer,
    renderBlock: (block) => renderBlock(block, !isViewMode),
    buildNavigation: () => buildNavigation(),
    renderTodaySections: refreshTodaySections,
    renderStickyNotes: () => renderStickyNotes()
  });

  // ============================================================
  //  Keyboard handlers
  // ============================================================

  function isCaretAtEditableStart(editableEl) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!isNodeInsideEditable(range.startContainer, editableEl)) return false;
    const probe = document.createRange();
    probe.selectNodeContents(editableEl);
    probe.setEnd(range.startContainer, range.startOffset);
    return stripEditableFillerText(probe.toString()).length === 0;
  }

  function placeCaretAtStart(editableEl) {
    const range = document.createRange();
    range.selectNodeContents(editableEl);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function isCaretOnFirstEditableLine(editableEl) {
    if (!editableEl) return true;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return true;
    const range = sel.getRangeAt(0);
    if (!isNodeInsideEditable(range.startContainer, editableEl)) return true;
    const beforeCaret = document.createRange();
    beforeCaret.setStart(editableEl, 0);
    beforeCaret.setEnd(range.startContainer, range.startOffset);
    // カーソルより前に<br>がなければ最上行にいる
    return !beforeCaret.cloneContents().querySelector('br');
  }

  // 末尾の空行（末尾<br> + ゼロ幅フィラー span）の上にキャレットがあるか。
  // フィラーのゼロ幅文字のせいで、この空行を消すのにBackspaceが2回必要になっていた。
  function isCaretAtTrailingFillerLine(editableEl) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const filler = getTrailingEditableFiller(editableEl);
    if (!filler) return false;
    const br = filler.previousSibling;
    if (!br || br.nodeType !== Node.ELEMENT_NODE || br.tagName !== 'BR') return false;
    const range = sel.getRangeAt(0);
    if (!isNodeInsideEditable(range.startContainer, editableEl)) return false;
    if (isNodeInsideEditable(range.startContainer, filler)) return true; // フィラー内
    // ce直下で、フィラー(最終子)以降を指している＝末尾
    if (range.startContainer === editableEl) return range.startOffset >= editableEl.childNodes.length - 1;
    return false;
  }

  // 末尾の空行を1回で削除する（フィラー直前の<br>を1つ取り除き、フィラーを貼り直す）
  function removeTrailingFillerLine(editableEl) {
    const filler = getTrailingEditableFiller(editableEl);
    if (!filler) return false;
    const br = filler.previousSibling;
    if (!br || br.nodeType !== Node.ELEMENT_NODE || br.tagName !== 'BR') return false;
    br.remove();
    const newFiller = syncEditableTrailingFiller(editableEl);
    const sel = window.getSelection();
    const range = document.createRange();
    if (newFiller) {
      range.setStartBefore(newFiller);
    } else {
      range.selectNodeContents(editableEl);
      range.collapse(false);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  function handleBlockKeydown(e, block, blockEl) {
    if ((block.type === 'heading' || block.type === 'paragraph') && isEnterKeyEvent(e)) {
      if (!e.shiftKey) {
        // IME変換中またはIME確定直後のEnterは無視
        if (isCompositionEnterEvent(e)) { e.preventDefault(); return; }
        const enterTargetEditable = getTextEditingElement(e.target);
        if (enterTargetEditable && compositionJustEndedEditable.has(enterTargetEditable)) { e.preventDefault(); return; }
        // 通常のEnter: 改行挿入
        e.preventDefault();
        if (enterTargetEditable) {
          enterHandledByKeydown.add(enterTargetEditable);
          setTimeout(() => enterHandledByKeydown.delete(enterTargetEditable), 0);
        }
        performParagraphEnter(e.target);
      } else {
        e.preventDefault();
        clearPendingHistoryShortcut();
        syncAllFromDOM();
        const undoSnapshotJson = serializeContentForSave();
        const newBlock = { id: uid(), type: 'paragraph', text: '', indent: block.indent || 0 };
        insertBlockAfter(block.id, newBlock);
        render();
        saveContent({ undoSnapshotJson });
        // Focus the new block
        setTimeout(() => {
          const newEl = document.getElementById(`block-${newBlock.id}`);
          if (newEl) {
            const ce = newEl.querySelector('[contenteditable]');
            if (ce) ce.focus();
          }
        }, 10);
      }
      return;
    }

    if ((block.type === 'heading' || block.type === 'paragraph') && !e.shiftKey && isAmbiguousProcessEnterEvent(e)) {
      armPendingUnknownEnterFallback(e.target);
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      const ce = blockEl.querySelector('[contenteditable]');
      // 末尾の空行（末尾<br>+フィラー）はBackspace1回で消す。
      // （フィラーのゼロ幅文字のせいで従来は2回必要だった問題への対策）
      if (e.key === 'Backspace' && !e.shiftKey && ce && isCaretAtTrailingFillerLine(ce)) {
        e.preventDefault();
        clearPendingHistoryShortcut();
        removeTrailingFillerLine(ce);
        recordEditableHistorySnapshot(ce);
        syncEditedBlockAndRefreshStatus(ce);
        return;
      }
      // Backspace at the very start of an indented paragraph removes one indent
      // level — the intuitive "oops, I pressed Tab" undo. Indent stays clean
      // block data (no literal spaces), so this never reintroduces whitespace cruft.
      if (e.key === 'Backspace' && block.type === 'paragraph' && (block.indent || 0) > 0 && ce && isCaretAtEditableStart(ce)) {
        e.preventDefault();
        clearPendingHistoryShortcut();
        syncAllFromDOM();
        const undoSnapshotJson = serializeContentForSave();
        block.indent = Math.max(0, (block.indent || 0) - 1);
        render();
        saveContent({ undoSnapshotJson });
        setTimeout(() => {
          const el = document.getElementById(`block-${block.id}`);
          const nce = el && el.querySelector('[contenteditable]');
          if (nce) { nce.focus(); placeCaretAtStart(nce); }
        }, 10);
        return;
      }
      // 空行だけの段落では、カーソルが最上行にあるときだけ段落削除を受け付ける
      // （それ以外の行ではデフォルト動作 = 改行の削除に任せる）
      if (ce && stripTags(ce.innerHTML).trim() === '' && isCaretOnFirstEditableLine(ce)) {
        const found = findBlockList(block.id, content.blocks);
        if (found && found.list.length > 1) {
          e.preventDefault();
          syncAllFromDOM();
          removeBlockAndPersist(block.id, {
            focusAdjacent: true,
            successMessage: '空のブロックを削除しました',
            successDuration: 1200
          });
        }
      }
    }

    if (e.key === 'Tab') {
      if (block.type === 'paragraph') {
        e.preventDefault();
        clearPendingHistoryShortcut();
        syncAllFromDOM();
        const undoSnapshotJson = serializeContentForSave();
        if (e.shiftKey) {
          block.indent = Math.max(0, (block.indent || 0) - 1);
        } else {
          block.indent = Math.min(3, (block.indent || 0) + 1);
        }
        render();
        saveContent({ undoSnapshotJson });
        setTimeout(() => {
          const el = document.getElementById(`block-${block.id}`);
          if (el) {
            const ce = el.querySelector('[contenteditable]');
            if (ce) ce.focus();
          }
        }, 10);
      }
    }
  }

  // ============================================================
  //  Global keyboard shortcuts
  // ============================================================

  // ── Image paste handler (capture phase: catches paste even outside contenteditable) ──
  document.addEventListener('paste', (e) => {
    if (isViewMode) return;
    if (handleBlockPaste(e)) return;
    // Only handle when paste did NOT originate from a contenteditable
    // (those are handled per-block above via handleImagePaste)
    if (isTextEditingTarget(e.target)) return;
    handleImagePaste(e, null);
  }, { capture: true });

  document.addEventListener('copy', (e) => {
    const copiedBlocks = copySelectedBlocksToClipboard(e);
    if (!copiedBlocks.length) return;
    showToast(
      copiedBlocks.length > 1
        ? `${copiedBlocks.length}個のブロックをコピーしました`
        : 'ブロックをコピーしました',
      1200
    );
  });

  document.addEventListener('cut', (e) => {
    const cutBlocks = copySelectedBlocksToClipboard(e);
    if (!cutBlocks.length) return;

    const blockIdsToRemove = getSelectedBlockIdsForDeletion();
    removeBlockAndPersist(blockIdsToRemove, {
      successMessage: cutBlocks.length > 1
        ? `${cutBlocks.length}個のブロックを切り取りました。Ctrl+Zで元に戻せます`
        : 'ブロックを切り取りました。Ctrl+Zで元に戻せます',
      successDuration: 1800
    });
  });

  document.addEventListener('keydown', (e) => {
    // Ctrl+Z = Undo
    if ((e.ctrlKey || e.metaKey) && hasShortcutKey(e, 'z') && !e.shiftKey) {
      if (pendingHistoryShortcut === 'undo') {
        e.preventDefault();
        performUndo();
        return;
      }
      if (performEditableUndo(e.target)) {
        e.preventDefault();
        return;
      }
      // ここに来る＝本文editableのローカル履歴を使い切った or 非編集領域。
      // コード/タイトル等のtextarea/inputはネイティブundoが安全なのでそちらに任せる。
      // それ以外（contenteditable枯渇 / 非編集）はドキュメントundoにフォールバックし、
      // Tabインデントや段落作成などの構造操作も跨いで戻れるようにする（連鎖可）。
      const undoEditable = getTextEditingElement(e.target);
      if (undoEditable && undoEditable.matches('textarea, input[type="text"], input[type="date"]')) return;
      e.preventDefault();
      performUndo();
      return;
    }

    // Ctrl+Y or Ctrl+Shift+Z = Redo
    if ((e.ctrlKey || e.metaKey) && (hasShortcutKey(e, 'y') || (hasShortcutKey(e, 'z') && e.shiftKey))) {
      if (pendingHistoryShortcut === 'redo') {
        e.preventDefault();
        performRedo();
        return;
      }
      if (performEditableRedo(e.target)) {
        e.preventDefault();
        return;
      }
      // undo と対称: textarea/input はネイティブredo、それ以外はドキュメントredoへ
      const redoEditable = getTextEditingElement(e.target);
      if (redoEditable && redoEditable.matches('textarea, input[type="text"], input[type="date"]')) return;
      e.preventDefault();
      performRedo();
      return;
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedBlockIds.size > 0 && !isTextEditingTarget(e.target)) {
      e.preventDefault();
      syncAllFromDOM();
      const blockIdsToRemove = getSelectedBlockIdsForDeletion();
      if (!blockIdsToRemove.length) {
        clearSelectedBlocks();
        return;
      }

      removeBlockAndPersist(blockIdsToRemove, {
        successMessage: blockIdsToRemove.length > 1
          ? `${blockIdsToRemove.length}個のブロックを削除しました。Ctrl+Zで元に戻せます`
          : 'ブロックを削除しました。Ctrl+Zで元に戻せます',
        successDuration: 2200
      });
      return;
    }

    // Ctrl+S = Save
    if ((e.ctrlKey || e.metaKey) && hasShortcutKey(e, 's')) {
      e.preventDefault();
      syncAllFromDOM();
      saveContent();
    }

    // Ctrl+E = Inline code
    if ((e.ctrlKey || e.metaKey) && hasShortcutKey(e, 'e')) {
      e.preventDefault();
      clearPendingHistoryShortcut();
      toggleInlineCode();
      recordEditableHistorySnapshot(e.target);
      syncAllFromDOM();
      saveContent();
    }

    // Ctrl+B = Bold
    if ((e.ctrlKey || e.metaKey) && hasShortcutKey(e, 'b')) {
      e.preventDefault();
      clearPendingHistoryShortcut();
      document.execCommand('bold');
      recordEditableHistorySnapshot(e.target);
      syncAllFromDOM();
      saveContent();
    }

    // Ctrl+F = in-page search (overrides native find so collapsed sections are searchable)
    if ((e.ctrlKey || e.metaKey) && hasShortcutKey(e, 'f')) {
      e.preventDefault();
      openSearch();
      return;
    }

    // Escape = close menus
    if (e.key === 'Escape') {
      if (isSearchOpen()) { closeSearch(); return; }
      closeMenus();
      $('#historyOverlay').classList.remove('show');
      clearSelectedBlocks();
    }
  });

  // ============================================================
  //  In-page search (Ctrl+F)
  //  Finds text across collapsed sections (native find cannot, since
  //  collapsed bodies are display:none). Highlights via the CSS Custom
  //  Highlight API — no DOM mutation, so contenteditable HTML is never
  //  altered or persisted.
  // ============================================================
  let searchMatches = [];
  let searchIndex = -1;
  let searchActive = false;
  let searchDebounce = null;
  const SEARCH_SKIP_SELECTOR = '.block-controls, .add-block-row, .section-preview, .section-badge, .toggle-icon';
  const supportsHighlightApi = typeof window.Highlight === 'function' && !!(window.CSS && CSS.highlights);

  function isSearchOpen() { return searchActive; }

  function openSearch() {
    const bar = $('#searchBar');
    const input = $('#searchInput');
    if (!bar || !input) return;
    searchActive = true;
    bar.style.display = 'flex';
    const selected = window.getSelection ? String(window.getSelection()).trim() : '';
    if (selected && selected.length <= 80 && !selected.includes('\n')) input.value = selected;
    input.focus();
    input.select();
    if (input.value) runSearch(input.value);
  }

  function closeSearch() {
    searchActive = false;
    const bar = $('#searchBar');
    if (bar) bar.style.display = 'none';
    clearSearchHighlights();
    searchMatches = [];
    searchIndex = -1;
  }

  function clearSearchHighlights() {
    if (!supportsHighlightApi) return;
    CSS.highlights.delete('search-hit');
    CSS.highlights.delete('search-current');
  }

  function getOwningBlock(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el && el.closest ? el.closest('.block') : null;
  }

  function buildSearchMatches(query) {
    const matches = [];
    const container = $('#blocksContainer');
    if (!container || !query) return matches;
    const needle = query.toLowerCase();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (node.tagName === 'TEXTAREA') return NodeFilter.FILTER_ACCEPT;
          if (node.matches && node.matches(SEARCH_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return node.data && node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const isTextarea = node.nodeType === 1;
      const hay = (isTextarea ? (node.value || '') : node.data).toLowerCase();
      let from = 0, idx;
      while ((idx = hay.indexOf(needle, from)) !== -1) {
        const m = { start: idx, end: idx + needle.length, blockEl: getOwningBlock(node) };
        if (isTextarea) { m.kind = 'textarea'; m.textarea = node; }
        else { m.kind = 'text'; m.node = node; }
        matches.push(m);
        from = idx + needle.length;
      }
    }
    return matches;
  }

  function rangeForMatch(m) {
    const r = document.createRange();
    r.setStart(m.node, m.start);
    r.setEnd(m.node, m.end);
    return r;
  }

  function applyAllHighlights() {
    if (!supportsHighlightApi) return;
    const hit = new Highlight();
    for (const m of searchMatches) {
      if (m.kind !== 'text') continue;
      try { hit.add(rangeForMatch(m)); } catch (_) {}
    }
    CSS.highlights.set('search-hit', hit);
  }

  function applyCurrentHighlight() {
    const m = searchMatches[searchIndex];
    if (!m) return;
    if (m.kind === 'text' && supportsHighlightApi) {
      const cur = new Highlight();
      cur.priority = 1;
      try { cur.add(rangeForMatch(m)); CSS.highlights.set('search-current', cur); } catch (_) {}
    } else if (m.kind === 'textarea') {
      if (supportsHighlightApi) CSS.highlights.delete('search-current');
      try { m.textarea.setSelectionRange(m.start, m.end); } catch (_) {}
    }
  }

  function updateSearchCount() {
    const countEl = $('#searchCount');
    if (!countEl) return;
    if (searchMatches.length === 0) {
      countEl.textContent = '0 / 0';
      countEl.classList.add('no-match');
    } else {
      countEl.textContent = `${searchIndex + 1} / ${searchMatches.length}`;
      countEl.classList.remove('no-match');
    }
  }

  function revealSearchMatch(m) {
    if (!m) return;
    const anchorEl = m.kind === 'textarea' ? m.textarea : (m.node.parentElement || m.blockEl);
    if (anchorEl) expandCollapsedSectionAncestors(anchorEl, expandLiveSectionBlock, { expandTargetSection: true });
    const scrollEl = m.kind === 'textarea' ? m.textarea : (m.blockEl || anchorEl);
    if (scrollEl && scrollEl.scrollIntoView) scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function gotoSearchIndex(i) {
    if (searchMatches.length === 0) return;
    searchIndex = (i % searchMatches.length + searchMatches.length) % searchMatches.length;
    revealSearchMatch(searchMatches[searchIndex]);
    applyCurrentHighlight();
    updateSearchCount();
  }

  function pickInitialIndex() {
    for (let i = 0; i < searchMatches.length; i++) {
      const el = searchMatches[i].blockEl;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height > 0 && rect.top >= 60) return i;
    }
    return 0;
  }

  function runSearch(query) {
    clearSearchHighlights();
    searchMatches = buildSearchMatches(query);
    if (searchMatches.length === 0) {
      searchIndex = -1;
      updateSearchCount();
      return;
    }
    applyAllHighlights();
    gotoSearchIndex(pickInitialIndex());
  }

  function initSearch() {
    const input = $('#searchInput');
    if (!input) return;
    input.addEventListener('input', () => {
      if (searchDebounce) clearTimeout(searchDebounce);
      const q = input.value;
      searchDebounce = setTimeout(() => {
        if (q) runSearch(q);
        else { clearSearchHighlights(); searchMatches = []; searchIndex = -1; updateSearchCount(); }
      }, 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); gotoSearchIndex(searchIndex + (e.shiftKey ? -1 : 1)); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    });
    $('#searchNext').addEventListener('click', () => gotoSearchIndex(searchIndex + 1));
    $('#searchPrev').addEventListener('click', () => gotoSearchIndex(searchIndex - 1));
    $('#searchClose').addEventListener('click', () => closeSearch());
  }

  function toggleInlineCode() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;

    // Check if selection is already inside a code element
    const ancestor = sel.anchorNode.parentElement;
    if (ancestor && ancestor.tagName === 'CODE') {
      // Unwrap
      const parent = ancestor.parentNode;
      while (ancestor.firstChild) parent.insertBefore(ancestor.firstChild, ancestor);
      parent.removeChild(ancestor);
    } else {
      // Wrap
      const code = document.createElement('code');
      try {
        range.surroundContents(code);
      } catch (ex) {
        // Selection spans multiple elements, fallback
        const text = range.extractContents();
        code.appendChild(text);
        range.insertNode(code);
      }
    }
  }

  // ============================================================
  //  Add block menu
  // ============================================================

  function showHeadingJumpMenu(e, headings) {
    // 既存のジャンプメニューを閉じる（共有HTML/閲覧モード両対応のため自己完結）
    var existing = document.querySelector('.heading-jump-menu');
    if (existing) existing.remove();
    if (typeof closeMenus === 'function') { try { closeMenus(); } catch (_) {} }

    var menu = document.createElement('div');
    menu.className = 'add-menu heading-jump-menu';

    var label = document.createElement('div');
    label.className = 'add-menu-label';
    label.textContent = '見出しへジャンプ';
    menu.appendChild(label);

    var doJump = (typeof window !== 'undefined' && window.jumpToBlock)
      ? window.jumpToBlock
      : (typeof jumpToBlock === 'function' ? jumpToBlock : null);

    function closeThisMenu() {
      menu.remove();
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', closeThisMenu, true);
    }
    function onDocDown(ev) { if (!menu.contains(ev.target)) closeThisMenu(); }
    function onKey(ev) { if (ev.key === 'Escape') closeThisMenu(); }

    headings.forEach(function(h) {
      var btn = document.createElement('button');
      btn.textContent = stripTags(h.text || '') || '(無題の見出し)';
      btn.addEventListener('click', function() {
        closeThisMenu();
        if (doJump) doJump(h.id);
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);

    // 画面外にはみ出さないよう位置を補正
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    var vw = window.scrollX + document.documentElement.clientWidth;
    var vh = window.scrollY + document.documentElement.clientHeight;
    var x = e.pageX;
    var y = e.pageY;
    if (x + mw > vw) x = Math.max(window.scrollX + 4, vw - mw - 4);
    if (y + mh > vh) y = Math.max(window.scrollY + 4, vh - mh - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // 直後の同一イベントで閉じないよう次tickでリスナー登録
    setTimeout(function() {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', closeThisMenu, true);
    }, 0);

    e.stopPropagation();
  }

  function showAddMenu(e, targetList, parentId) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'add-menu';

    const types = [
      { type: 'heading', label: '見出し' },
      { type: 'paragraph', label: '段落' },
      { type: 'code', label: 'コードブロック' },
      { type: 'table', label: 'テーブル' },
      { type: 'section', label: '折りたたみセクション（大）' },
      { type: 'section-small', label: '引きだし（小さな折りたたみ）' },
    ];

    types.forEach(t => {
      const btn = document.createElement('button');
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        syncAllFromDOM();
        const undoSnapshotJson = serializeContentForSave();
        const newBlock = createDefaultBlock(t.type);
        if (newBlock.type === 'code') expandedCodeBlockIds.add(newBlock.id);
        if (targetList) {
          targetList.push(newBlock);
        } else {
          content.blocks.push(newBlock);
        }
        closeMenus();
        render();
        saveContent({ undoSnapshotJson });
        setTimeout(() => {
          const el = document.getElementById(`block-${newBlock.id}`);
          if (el) {
            const ce = el.querySelector('[contenteditable]') || el.querySelector('textarea');
            if (ce) ce.focus();
          }
        }, 10);
      });
      menu.appendChild(btn);
    });

    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';
    document.body.appendChild(menu);
    activeMenu = menu;
    e.stopPropagation();
  }

  function createDefaultBlock(type) {
    switch (type) {
      case 'heading':
        return { id: uid(), type: 'heading', level: 1, text: '' };
      case 'paragraph':
        return { id: uid(), type: 'paragraph', text: '', indent: 0 };
      case 'code':
        return { id: uid(), type: 'code', language: '', content: '' };
      case 'table':
        return { id: uid(), type: 'table', headers: ['列1', '列2', '列3'], rows: [['', '', '']] };
      case 'section':
        return { id: uid(), type: 'section', title: '新しいセクション', collapsed: false, children: [] };
      case 'section-small':
        return { id: uid(), type: 'section', size: 'small', title: '新しい小セクション', collapsed: false, children: [] };
      default:
        return { id: uid(), type: 'paragraph', text: '', indent: 0 };
    }
  }

  document.addEventListener('click', (e) => {
    if (activeMenu && !activeMenu.contains(e.target)) closeMenus();
    if (!selectedBlockIds.size) return;
    const blockEl = e.target.closest('.block[data-block-id]');
    if (!blockEl || !selectedBlockIds.has(blockEl.dataset.blockId)) clearSelectedBlocks();
  });

  // ============================================================
  //  Toolbar buttons
  // ============================================================

  function getActiveBlockId() {
    const active = document.activeElement;
    if (active) {
      const blockEl = active.closest('[data-block-id]');
      if (blockEl) return blockEl.dataset.blockId;
    }
    return lastFocusedBlockId;
  }

  function addBlockViaToolbar(type) {
    syncAllFromDOM();
    const undoSnapshotJson = serializeContentForSave();
    const newBlock = createDefaultBlock(type);
    if (newBlock.type === 'code') expandedCodeBlockIds.add(newBlock.id);
    const activeId = getActiveBlockId();
    if (activeId) {
      // Insert after the currently focused block (works inside sections too)
      if (!insertBlockAfter(activeId, newBlock)) {
        content.blocks.push(newBlock);
      }
    } else {
      content.blocks.push(newBlock);
    }
    render();
    saveContent({ undoSnapshotJson });
    setTimeout(() => {
      const el = document.getElementById(`block-${newBlock.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const ce = el.querySelector('[contenteditable]') || el.querySelector('textarea');
        if (ce) ce.focus();
      }
    }, 50);
  }

  $('#btnAddHeading').addEventListener('click', () => addBlockViaToolbar('heading'));
  $('#btnAddParagraph').addEventListener('click', () => addBlockViaToolbar('paragraph'));
  $('#btnAddCode').addEventListener('click', () => addBlockViaToolbar('code'));
  $('#btnAddTable').addEventListener('click', () => addBlockViaToolbar('table'));
  $('#btnAddSection').addEventListener('click', () => addBlockViaToolbar('section'));
  $('#btnAddSmallSection').addEventListener('click', () => addBlockViaToolbar('section-small'));

  // 画像追加ボタン: ファイル選択ダイアログを開く
  $('#btnAddImage').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        syncAllFromDOM();
        const newBlock = { id: uid(), type: 'image', src: evt.target.result, alt: file.name, addedDate: todayStr() };
        if (lastFocusedBlockId) {
          insertBlockAfter(lastFocusedBlockId, newBlock);
        } else {
          content.blocks.push(newBlock);
        }
        render();
        saveContent();
        showToast('画像を追加しました', 1500);
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });
  $('#btnInlineCode').addEventListener('click', () => {
    toggleInlineCode();
    syncAllFromDOM();
    saveContent();
  });
  $('#btnBold').addEventListener('click', () => {
    document.execCommand('bold');
    syncAllFromDOM();
    saveContent();
  });
  $('#btnUndo').addEventListener('click', () => performUndo());
  $('#btnRedo').addEventListener('click', () => performRedo());

  function openSettingsOverlay() {
    const config = getAppConfig();
    const displayTitle = config.displayTitle || DEFAULT_DOCUMENT_TITLE;
    const documentTitle = config.documentTitle || DEFAULT_DOCUMENT_TITLE;
    $('#settingsDisplayTitle').value = displayTitle;
    // ドキュメントタイトルが表示名と同じ（＝未カスタマイズ）なら入力は空にして、
    // 表示名を薄いプレースホルダとして見せる。異なる場合だけ実値を入れる。
    $('#settingsDocumentTitle').value = (documentTitle === displayTitle) ? '' : documentTitle;
    $('#settingsDocumentTitle').placeholder = displayTitle;
    $('#settingsAutosaveMinutes').value = String(Math.max(1, Math.round(getAutosaveIntervalMs() / 60000)));
    $('#settingsRedoLimit').value = String(getRedoLimit());
    fillFontSelect($('#settingsFontUi'), UI_FONT_PRESETS, config.fontUi);
    fillFontSelect($('#settingsFontCode'), CODE_FONT_PRESETS, config.fontCode);
    $('#settingsFontUiCustom').value = config.fontUiCustom || '';
    $('#settingsFontCodeCustom').value = config.fontCodeCustom || '';
    $('#settingsFontSizeBase').value = String(clampFontSize(config.fontSizeBase, DEFAULT_FONT_SIZE_BASE));
    syncFontCustomVisibility();
    previewFontSettings();
    $('#settingsOverlay').classList.add('show');
    setTimeout(() => $('#settingsDisplayTitle').focus(), 0);
  }

  function closeSettingsOverlay() {
    $('#settingsOverlay').classList.remove('show');
    // プレビューで当てた見た目を、保存済みの設定へ戻す
    applyFontSettings(getAppConfig(), document.documentElement);
  }

  async function saveSettings(event) {
    if (event) event.preventDefault();

    const displayTitleInput = $('#settingsDisplayTitle');
    const documentTitleInput = $('#settingsDocumentTitle');
    const autosaveMinutesInput = $('#settingsAutosaveMinutes');
    const redoLimitInput = $('#settingsRedoLimit');
    const saveButton = $('#settingsSave');

    const displayTitle = (displayTitleInput.value || '').trim() || DEFAULT_DOCUMENT_TITLE;
    // ドキュメントタイトルが空欄なら表示名に同期する（「変更がなければ表示名と同じ」）
    const documentTitle = (documentTitleInput.value || '').trim() || displayTitle;
    const autosaveMinutes = parseSettingsInteger(autosaveMinutesInput, { min: 1, max: 120, label: '自動保存間隔' });
    if (autosaveMinutes === null) return;
    const redoLimit = parseSettingsInteger(redoLimitInput, { min: 10, max: 500, label: 'Redo 上限' });
    if (redoLimit === null) return;

    syncAllFromDOM();
    const fontSizeBase = parseSettingsInteger($('#settingsFontSizeBase'),
      { min: MIN_FONT_SIZE_BASE, max: MAX_FONT_SIZE_BASE, label: '文字の大きさ' });
    if (fontSizeBase === null) return;

    updateAppConfig({
      displayTitle,
      documentTitle,
      autosaveIntervalMs: autosaveMinutes * 60 * 1000,
      redoLimit,
      fontUi: $('#settingsFontUi').value,
      fontUiCustom: $('#settingsFontUiCustom').value,
      fontCode: $('#settingsFontCode').value,
      fontCodeCustom: $('#settingsFontCodeCustom').value,
      fontSizeBase
    });
    startAutosave();
    refreshSaveStatus();

    saveButton.disabled = true;
    try {
      const result = await saveContent({ force: true });
      if (result.ok || result.skipped) {
        closeSettingsOverlay();
        showToast('設定を保存しました', 1600);
      } else {
        showToast('設定の保存に失敗しました', 2200);
      }
    } finally {
      saveButton.disabled = false;
    }
  }

  // ── フォント欄のヘルパ ──────────────────────────────
  function fillFontSelect(select, presets, selectedKey) {
    if (!select) return;
    select.innerHTML = '';
    Object.keys(presets).forEach(key => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = presets[key].label;
      select.appendChild(opt);
    });
    select.value = presets[selectedKey] ? selectedKey : 'default';
  }

  // 「自分で指定…」のときだけ自由入力欄を出す
  function syncFontCustomVisibility() {
    const uiCustom = $('#settingsFontUiCustom');
    const codeCustom = $('#settingsFontCodeCustom');
    if (uiCustom) uiCustom.hidden = ($('#settingsFontUi').value !== 'custom');
    if (codeCustom) codeCustom.hidden = ($('#settingsFontCode').value !== 'custom');
  }

  // 保存を押す前に、選んだ結果を画面へ当てて見せる。
  // ここでは content を書き換えない（閉じるを押したら元に戻る）。
  function previewFontSettings() {
    applyFontSettings({
      fontUi: $('#settingsFontUi').value,
      fontUiCustom: $('#settingsFontUiCustom').value,
      fontCode: $('#settingsFontCode').value,
      fontCodeCustom: $('#settingsFontCodeCustom').value,
      fontSizeBase: $('#settingsFontSizeBase').value
    }, document.documentElement);
  }

  ['#settingsFontUi', '#settingsFontCode'].forEach(sel => {
    $(sel).addEventListener('change', () => { syncFontCustomVisibility(); previewFontSettings(); });
  });
  ['#settingsFontUiCustom', '#settingsFontCodeCustom', '#settingsFontSizeBase'].forEach(sel => {
    $(sel).addEventListener('input', () => previewFontSettings());
  });


  // ============================================================
  //  ファイルメニュー（読み込み・書き出し）
  // ============================================================

  // ============================================================
  //  ツールバーの詰め方
  // ------------------------------------------------------------
  //  画面幅を数字で決め打ちすると、ボタンを1つ増減しただけで合わなくなる。
  //  実際にはみ出したかを測って、優先度の低いものから順に削る。
  //  ★狙いは「ヘッダーが必要とする幅に画面が届いた瞬間に縮む」こと。
  //    余裕があるうちは何も削らない。
  // ============================================================
  // 段8以上（スマホなど）で、ヘッダーから外す操作。
  // ★ここには「本物のボタンのid」だけを書く。押したらそのボタンをそのまま押す。
  //   動きを書き写すと、片方だけ直したときに静かに食い違う。
  const MORE_ITEMS = [
    { group: '書く', ids: ['btnAddSection', 'btnAddHeading', 'btnAddParagraph',
                          'btnAddCode', 'btnAddTable', 'btnAddSmallSection', 'btnAddImage'] },
    { group: '文字', ids: ['btnInlineCode', 'btnBold'] },
    { group: '戻す', ids: ['btnUndo', 'btnRedo'] },
    { group: 'そのほか', ids: ['btnReorgMode', 'btnHistory'] },
  ];

  const TIGHT_LEVELS = 9;
  function fitToolbar() {
    const tb = document.getElementById('toolbar');
    if (!tb) return;
    // いったん全部戻してから、はみ出す間だけ段を上げる。
    for (let i = 1; i <= TIGHT_LEVELS; i++) tb.classList.remove('tight-' + i);
    const moreWrap = document.getElementById('moreWrap');
    if (moreWrap) moreWrap.hidden = true;
    let level = 0;
    // +1 は小数の丸め対策。ぴったりのときに無駄に縮めない。
    while (level < TIGHT_LEVELS && tb.scrollWidth > tb.clientWidth + 1) {
      level++;
      tb.classList.add('tight-' + level);
      // 段8に入る＝ヘッダーから操作を外し始める。外した先（…）を先に出す。
      // 出してから測り直さないと、… のぶんの幅を数えそこねる。
      if (level === 8 && moreWrap) moreWrap.hidden = false;
    }
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => fitToolbar());
    const tbEl = document.getElementById('toolbar');
    if (tbEl) {
      ro.observe(tbEl);
      // ★器だけを見ていると取りこぼす。
      //   幅が足りなくなる原因は「器が縮んだ」ときだけではなく、
      //   「中身が広がった」ときもある（アイコンの字が後から読み込まれて
      //   ボタンが数px太る）。実際に本番のスマホ幅で、読み込み直後は段8で
      //   止まり、そのあと中身が 4px 広がって右端の設定が画面の外へ出た。
      //   中の一つひとつも見張る。
      for (const child of tbEl.children) ro.observe(child);
    }
  }
  window.addEventListener('resize', fitToolbar);
  // 字幅が確定してから測る（フォントの読み込みで幅が変わる）
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitToolbar);
  // 画像やアイコンまで含めて読み終わったところでもう一度
  window.addEventListener('load', fitToolbar);
  setTimeout(fitToolbar, 0);

  // ============================================================
  //  「…」— 狭い画面でヘッダーから外した操作の入れ物
  // ------------------------------------------------------------
  //  中身は本物のボタンを指しているだけ。押すとそのボタンを押す。
  //  だから「整理モードが今ONか」「元に戻せるか」といった状態も、
  //  本物のボタンから読んでそのまま映す（二重に持たない）。
  // ============================================================
  const moreWrap = $('#moreWrap');
  const btnMore = $('#btnMore');
  const moreMenu = $('#moreMenu');

  // 名前は本物のボタンから取る。ここで書き直すと呼び名が2つになる。
  // ★絵だけのボタン（</> や ↩）は、見た目の文字をそのまま使うと
  //   メニューで「</>」「↩」と並んで何のことか分からなくなる。
  //   読み上げ用の名前（aria-label）と説明（title）を先に見る。
  //   見る順: .btn-label（字つきのボタン）→ aria-label（絵だけのボタンに付けてある）
  //           → 見えている文字 → title の頭。
  function labelOfButton(src) {
    const lbl = src.querySelector('.btn-label');
    if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
    const aria = src.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const t = src.textContent.trim();
    if (t) return t;
    if (src.title) return src.title.split(/[：:（(]/)[0].trim();   // 「整理モード：…」→「整理モード」
    return src.id;
  }

  function buildMoreMenu() {
    moreMenu.innerHTML = '';
    // ★「今このボタンが見えているか」で判断してはいけない。
    //   ここに入る物は、狭いから隠してあるだけで、使える。
    //   出してはいけないのは「閲覧モードで編集ができない」ときだけ。
    const viewing = document.body.classList.contains('view-mode');
    let any = false;

    for (const sec of MORE_ITEMS) {
      const usable = sec.ids
        .map(id => document.getElementById(id))
        .filter(el => el && !el.hidden)
        .filter(el => !(viewing && el.closest('.edit-only')));
      if (!usable.length) continue;

      const label = document.createElement('div');
      label.className = 'dropdown-label';
      label.textContent = sec.group;
      moreMenu.appendChild(label);

      for (const src of usable) {
        const b = document.createElement('button');
        b.className = 'dropdown-item';
        b.setAttribute('role', 'menuitem');
        b.disabled = src.disabled;

        const title = document.createElement('span');
        title.className = 'dropdown-item-title';
        title.textContent = labelOfButton(src);
        b.appendChild(title);

        if (src.classList.contains('active')) {
          const on = document.createElement('span');
          on.className = 'dropdown-item-meta';
          on.textContent = 'ON';
          b.appendChild(on);
        }
        if (src.title) b.setAttribute('data-help', src.title);

        b.addEventListener('click', () => {
          setMoreMenuOpen(false);
          src.click();              // ★本物を押す
        });
        moreMenu.appendChild(b);
        any = true;
      }
      const sep = document.createElement('div');
      sep.className = 'dropdown-sep';
      moreMenu.appendChild(sep);
    }
    // 最後の区切り線は要らない
    const last = moreMenu.lastElementChild;
    if (last && last.className === 'dropdown-sep') last.remove();

    if (!any) {
      const p = document.createElement('div');
      p.className = 'dropdown-hint';
      p.textContent = 'ここに入る操作はありません';
      moreMenu.appendChild(p);
    }
  }

  function setMoreMenuOpen(open) {
    if (open) buildMoreMenu();
    moreMenu.hidden = !open;
    btnMore.setAttribute('aria-expanded', open ? 'true' : 'false');
    btnMore.classList.toggle('is-open', open);
    if (!open && moreMenu.contains(document.activeElement)) btnMore.focus();
  }

  if (btnMore) {
    btnMore.addEventListener('click', (e) => {
      e.stopPropagation();
      setMoreMenuOpen(moreMenu.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== btnMore) {
        setMoreMenuOpen(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !moreMenu.hidden) setMoreMenuOpen(false);
    });
  }

  const fileMenu = $('#fileMenu');
  const btnFileMenu = $('#btnFileMenu');

  function setFileMenuOpen(open) {
    fileMenu.hidden = !open;
    btnFileMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
    btnFileMenu.classList.toggle('is-open', open);
    if (!open) {
      setFileMenuHint('');
      // ★閉じたら、開く前に居た場所（ボタン）へ戻す。
      //   戻さないとフォーカスが宙に浮き、次のTabがどこへ行くか分からなくなる。
      if (fileMenu.contains(document.activeElement)) btnFileMenu.focus();
    } else {
      // 開いたら最初の項目へ。矢印キーで辿り始められるようにする。
      const first = fileMenu.querySelector('.dropdown-item:not([disabled])');
      if (first) setTimeout(() => first.focus(), 0);
    }
  }

  // ★説明は、かざした項目のぶんだけ下の1行に出す。
  //   全項目の説明を常に出すと、説明のほうが項目より場所を取って読めなくなる。
  //   出る場所を1か所に固定するので、目が探し回らずに済む。
  const fileMenuHint = $('#fileMenuHint');
  function setFileMenuHint(text) {
    if (fileMenuHint) fileMenuHint.textContent = text || '';
  }
  if (fileMenu) {
    const pick = (t) => (t && t.closest ? t.closest('.dropdown-item') : null);
    fileMenu.addEventListener('mouseover', (e) => {
      const item = pick(e.target);
      if (item) setFileMenuHint(item.getAttribute('data-help') || '');
    });
    fileMenu.addEventListener('mouseleave', () => setFileMenuHint(''));
    // キーボードで辿る人にも同じ説明が出るようにする
    fileMenu.addEventListener('focusin', (e) => {
      const item = pick(e.target);
      if (item) setFileMenuHint(item.getAttribute('data-help') || '');
    });

    // ★role="menu" と書いた以上、矢印キーで辿れなければならない。
    //   読み上げソフトはメニュー役割に矢印操作を期待するので、
    //   Tab しか効かない状態は「何も名乗らない」より かえって困らせる。
    //   （かざす操作の無いタッチ画面でも、説明に辿り着く道が要る）
    function menuItems() {
      return [...fileMenu.querySelectorAll('.dropdown-item')]
        .filter(el => !el.disabled && el.offsetParent !== null);
    }
    fileMenu.addEventListener('keydown', (e) => {
      const items = menuItems();
      if (!items.length) return;
      const here = items.indexOf(document.activeElement);
      let next = -1;
      if (e.key === 'ArrowDown') next = here < 0 ? 0 : (here + 1) % items.length;
      else if (e.key === 'ArrowUp') next = here < 0 ? items.length - 1 : (here - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else return;
      e.preventDefault();
      items[next].focus();
    });
  }

  btnFileMenu.addEventListener('click', async (e) => {
    e.stopPropagation();
    const opening = fileMenu.hidden;
    setFileMenuOpen(opening);
    // 開くたびに読み直す。別PCが更新している場合があるので、覚えた値を使わない。
    if (opening) { await loadProjects(); renderProjectList(); }
  });
  document.addEventListener('click', (e) => {
    if (!fileMenu.hidden && !fileMenu.contains(e.target) && e.target !== btnFileMenu) setFileMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !fileMenu.hidden) setFileMenuOpen(false);
  });


  // ============================================================
  //  作業ファイル（プロジェクト）
  // ============================================================
  // 1つの作業ファイル = 内容 + 履歴 + 画像 が入った独立した1組。
  // 切り替えはサーバ側の向き先を変えるだけなので、切り替えたら必ず読み込み直す。

  let projectsCache = { currentId: 'default', projects: [] };

  function formatWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const p2 = n => String(n).padStart(2, '0');
    if (sameDay) return '今日 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function describeProject(p) {
    if (!p.started) return 'まだ開いていません';
    const parts = [];
    if (typeof p.blockCount === 'number') parts.push(p.blockCount + ' ブロック');
    const when = formatWhen(p.updatedAt);
    if (when) parts.push(when);
    return parts.join(' · ');
  }

  async function loadProjects() {
    try {
      projectsCache = await (await fetch('/api/projects')).json();
    } catch (_) {
      projectsCache = { currentId: 'default', projects: [] };
    }
    return projectsCache;
  }

  function renderProjectList() {
    const box = $('#projectList');
    if (!box) return;
    box.innerHTML = '';
    projectsCache.projects.forEach(p => {
      const b = document.createElement('button');
      b.className = 'dropdown-item project-item' + (p.id === projectsCache.currentId ? ' is-current' : '');
      b.setAttribute('role', 'menuitem');
      // ★かざしたとき下の行が空にならないようにする。
      //   隣の項目から移ってきたときだけ説明が消えるのは不親切。
      b.setAttribute('data-help', p.id === projectsCache.currentId
        ? 'いま開いている作業ファイルです'
        : '押すとこの作業ファイルに切り替わります');
      // ★「何ブロック・いつ」は説明ではなく、選ぶための手がかり。
      //   2行目に落とさず、名前と同じ行の右端に置く。
      b.innerHTML =
        '<span class="dropdown-item-title">' +
          '<span class="project-dot" aria-hidden="true"></span>' +
          '<span class="project-name">' + escapeHtml(p.name) + '</span>' +
        '</span>' +
        '<span class="dropdown-item-meta">' + escapeHtml(describeProject(p)) + '</span>';
      if (p.id === projectsCache.currentId) {
        b.disabled = true;
        b.title = 'いま開いています';
      } else {
        b.addEventListener('click', () => switchProject(p.id, p.name));
      }
      box.appendChild(b);
    });
  }

  async function switchProject(id, name) {
    setFileMenuOpen(false);
    // 切り替える前に、いまの作業ファイルへ確実に保存する。
    // これをしないと、編集中の内容が次の作業ファイルへ上書きされる事故が起きる。
    if (!isViewMode) {
      syncAllFromDOM();
      const r = await saveContent({ force: true });
      if (r && r.ok === false && !r.skipped) {
        showToast('いまの内容を保存できませんでした。切り替えを中止します', 3000);
        return;
      }
    }
    showToast('「' + name + '」を開いています…', 1500);
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(id) + '/open', { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        showToast('開けませんでした: ' + (e.error || res.status), 2600);
        return;
      }
    } catch (err) {
      showToast('開けませんでした: ' + err.message, 2600);
      return;
    }
    // 画面の状態（描画・履歴・付箋）を作り直すのが確実なので、読み込み直す
    window.location.reload();
  }

  $('#miNewProject').addEventListener('click', async () => {
    setFileMenuOpen(false);
    const name = window.prompt('新しい作業ファイルの名前を入れてください。\n（内容も履歴も、いまのものとは完全に分かれます）');
    if (name === null) return;
    if (!name.trim()) { showToast('名前が空です', 1800); return; }
    try {
      const res = await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { showToast('作れませんでした: ' + (j.error || res.status), 2600); return; }
      await switchProject(j.id, j.name);
    } catch (err) {
      showToast('作れませんでした: ' + err.message, 2600);
    }
  });

  // ── 整理（名前の変更・片付け）──────────────────────
  function renderProjectManageList() {
    const box = $('#projectManageList');
    box.innerHTML = '';
    projectsCache.projects.forEach(p => {
      const row = document.createElement('div');
      row.className = 'project-manage-row' + (p.id === projectsCache.currentId ? ' is-current' : '');
      const info = document.createElement('div');
      info.className = 'project-manage-info';
      // ★名前は名前だけを包む。
      //   以前は名前と「開いています」を1つの箱に入れ、その箱に
      //   「はみ出したら…で省略」を付けていたため、名前が長いと
      //   **印の方が切れた**（実機で「開いていま」まで見えていた）。
      //   省略するのは名前だけにする。
      info.innerHTML =
        '<span class="project-manage-name">' +
        '<span class="project-manage-name-text">' + escapeHtml(p.name) + '</span>' +
        (p.id === projectsCache.currentId ? '<span class="project-badge">開いています</span>' : '') +
        '</span>' +
        '<span class="project-manage-meta">' + escapeHtml(describeProject(p)) + '</span>';
      row.appendChild(info);

      const acts = document.createElement('div');
      acts.className = 'project-manage-actions';

      const ren = document.createElement('button');
      ren.className = 'settings-btn secondary';
      ren.textContent = '名前を変える';
      ren.addEventListener('click', async () => {
        const name = window.prompt('新しい名前', p.name);
        if (name === null || !name.trim()) return;
        const res = await fetch('/api/projects/' + encodeURIComponent(p.id), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { showToast('変えられませんでした: ' + (j.error || res.status), 2600); return; }
        await loadProjects();
        renderProjectManageList();
        renderProjectList();
        showToast('名前を変えました', 1600);
      });
      acts.appendChild(ren);

      const del = document.createElement('button');
      del.className = 'settings-btn secondary danger';
      del.textContent = '片付ける';
      if (p.isDefault) {
        del.disabled = true;
        del.title = '既定の作業ファイルは片付けられません';
      } else {
        del.addEventListener('click', async () => {
          if (!window.confirm('「' + p.name + '」を片付けます。\n\n' +
              '中身は _trash フォルダへ移すだけなので、後から取り出せます。よろしいですか？')) return;
          const res = await fetch('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) { showToast('片付けられませんでした: ' + (j.error || res.status), 2600); return; }
          if (p.id === projectsCache.currentId) { window.location.reload(); return; }
          await loadProjects();
          renderProjectManageList();
          renderProjectList();
          showToast('片付けました（_trash に残っています）', 2400);
        });
      }
      acts.appendChild(del);
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  $('#miManageProjects').addEventListener('click', async () => {
    setFileMenuOpen(false);
    await loadProjects();
    renderProjectManageList();
    $('#projectsOverlay').classList.add('show');
  });
  $('#projectsClose').addEventListener('click', () => $('#projectsOverlay').classList.remove('show'));
  $('#projectsCloseBtn').addEventListener('click', () => $('#projectsOverlay').classList.remove('show'));

  $('#miExportMd').addEventListener('click', () => {
    setFileMenuOpen(false);
    downloadFromApi('/api/export-md', 'export.md');
  });
  $('#miExportHtml').addEventListener('click', () => {
    setFileMenuOpen(false);
    $('#btnExportHtml').click();
  });

  // ── Markdown の読み込み ─────────────────────────────
  // 読み込んだ結果をいきなり反映しない。何件になるかを見せて、
  // 「後ろに足す」か「置き換える」かを選んでもらってから反映する。
  let pendingImport = null;

  $('#miImportMd').addEventListener('click', () => {
    setFileMenuOpen(false);
    if (isViewMode) { showToast('編集モードに切り替えてから読み込んでください', 2200); return; }
    $('#importMdInput').value = '';
    $('#importMdInput').click();
  });

  $('#importMdInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (err) {
      showToast('ファイルを読めませんでした: ' + err.message, 2600);
      return;
    }
    let result;
    try {
      const res = await fetch('/api/import-md', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: text })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast('変換に失敗しました: ' + (err.error || res.status), 2600);
        return;
      }
      result = await res.json();
    } catch (err) {
      showToast('変換に失敗しました: ' + err.message, 2600);
      return;
    }

    pendingImport = result;
    const s = result.stats || {};
    const rows = [
      ['見出し', s.heading], ['段落', s.paragraph], ['コード', s.code],
      ['表', s.table], ['折りたたみ', s.section]
    ].filter(r => r[1] > 0);
    $('#importFileName').textContent = file.name;
    $('#importSummary').innerHTML = rows.length
      ? '<span class="import-count-total">' + rows.reduce((a, r) => a + r[1], 0) + ' ブロック</span>' +
        rows.map(r => '<span class="import-count">' + r[0] + ' ' + r[1] + '</span>').join('')
      : '<span class="import-count-total">取り込めるものがありませんでした</span>';
    const warnBox = $('#importWarnings');
    if (result.warnings && result.warnings.length) {
      warnBox.hidden = false;
      warnBox.innerHTML = '<strong>読み込みにあたって</strong><ul>' +
        result.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>';
    } else {
      warnBox.hidden = true;
    }
    $('#importConfirm').disabled = rows.length === 0;
    document.querySelector('input[name="importMode"][value="append"]').checked = true;
    $('#importOverlay').classList.add('show');
  });

  function closeImportOverlay() {
    $('#importOverlay').classList.remove('show');
    pendingImport = null;
  }
  $('#importClose').addEventListener('click', closeImportOverlay);
  $('#importCancel').addEventListener('click', closeImportOverlay);

  $('#importConfirm').addEventListener('click', async () => {
    if (!pendingImport) return;
    const mode = (document.querySelector('input[name="importMode"]:checked') || {}).value || 'append';
    const blocks = pendingImport.blocks || [];
    const added = blocks.length;

    syncAllFromDOM();
    if (mode === 'replace') content.blocks = blocks;
    else content.blocks = content.blocks.concat(blocks);

    closeImportOverlay();
    render();
    const r = await saveContent({ force: true });
    if (r && r.ok === false && !r.skipped) showToast('保存に失敗しました', 2600);
    else showToast(added + ' ブロックを読み込みました', 2200);
  });

  // ── 履歴を HTML で書き出す ──────────────────────────
  $('#miExportHistoryHtml').addEventListener('click', async () => {
    setFileMenuOpen(false);
    let dates = [];
    try {
      dates = await (await fetch('/api/snapshots')).json();
    } catch (_) {}
    if (!Array.isArray(dates) || dates.length === 0) {
      showToast('まだ履歴がありません', 2200);
      return;
    }
    const fmt = d => String(d).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1/$2/$3');
    const fill = (sel, selected) => {
      sel.innerHTML = '';
      dates.forEach(d => {
        const o = document.createElement('option');
        o.value = d; o.textContent = fmt(d);
        sel.appendChild(o);
      });
      sel.value = selected;
    };
    fill($('#historyHtmlFrom'), dates[0]);
    fill($('#historyHtmlTo'), dates[dates.length - 1]);

    // ワンタッチの期間ボタン。押すたびに下の日付も一緒に変わるので、
    // 「何が出るのか」が選んだ時点で見える。
    const presets = $('#historyHtmlPresets');
    presets.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        presets.querySelectorAll('button').forEach(x => x.classList.remove('is-active'));
        b.classList.add('is-active');
        applyHistoryRange(b.dataset.range, dates);
      };
    });
    // 日付を手で変えたら、ボタンの選択表示は外す
    [$('#historyHtmlFrom'), $('#historyHtmlTo')].forEach(sel => {
      sel.onchange = () => {
        presets.querySelectorAll('button').forEach(x => x.classList.remove('is-active'));
        $('#historyHtmlHint').textContent = '';
        $('#historyHtmlHint').classList.remove('is-warn');
        $('#historyHtmlConfirm').disabled = false;
      };
    });
    // 既定は「今週」。記録が無ければ全期間へ落とす。
    const weekBtn = presets.querySelector('[data-range="week"]');
    weekBtn.classList.add('is-active');
    applyHistoryRange('week', dates);
    if ($('#historyHtmlConfirm').disabled) {
      presets.querySelectorAll('button').forEach(x => x.classList.remove('is-active'));
      presets.querySelector('[data-range="all"]').classList.add('is-active');
      applyHistoryRange('all', dates);
    }

    $('#historyHtmlOverlay').classList.add('show');
  });


  // ── 履歴の期間をワンタッチで選ぶ ────────────────────
  // 「先週ぶんを出したい」が実際にいちばん多い使い方なので、日付を2つ選ばせない。
  // 記録がある日付しか選べないので、押した範囲にいちばん近い日を選ぶ。
  function ymd(d) {
    const p2 = n => String(n).padStart(2, '0');
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate());
  }
  function mondayOf(d) {
    const x = new Date(d);
    const wd = (x.getDay() + 6) % 7;   // 月曜=0 になるようにずらす
    x.setDate(x.getDate() - wd);
    return x;
  }

  function applyHistoryRange(kind, dates) {
    if (!dates || !dates.length) return;
    const today = new Date();
    let from, to;
    if (kind === 'all') {
      from = dates[0]; to = dates[dates.length - 1];
    } else if (kind === 'week') {
      from = ymd(mondayOf(today)); to = ymd(today);
    } else if (kind === 'lastweek') {
      const mon = mondayOf(today);
      const lastMon = new Date(mon); lastMon.setDate(lastMon.getDate() - 7);
      const lastSun = new Date(mon); lastSun.setDate(lastSun.getDate() - 1);
      from = ymd(lastMon); to = ymd(lastSun);
    } else {
      const n = Number(kind);
      const s = new Date(today); s.setDate(s.getDate() - (n - 1));
      from = ymd(s); to = ymd(today);
    }
    // 記録がある日付に丸める（範囲に入る最初と最後）
    const inRange = dates.filter(d => d >= from && d <= to);
    const fromSel = $('#historyHtmlFrom');
    const toSel = $('#historyHtmlTo');
    const hint = $('#historyHtmlHint');
    if (!inRange.length) {
      hint.textContent = 'この期間には記録がありません。ほかの期間を選んでください。';
      hint.classList.add('is-warn');
      $('#historyHtmlConfirm').disabled = true;
      return;
    }
    fromSel.value = inRange[0];
    toSel.value = inRange[inRange.length - 1];
    hint.classList.remove('is-warn');
    hint.textContent = '記録のある日で ' + inRange.length + ' 日ぶん（' +
      inRange[0].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1/$2/$3') + ' 〜 ' +
      inRange[inRange.length - 1].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1/$2/$3') + '）';
    $('#historyHtmlConfirm').disabled = false;
  }

  function closeHistoryHtmlOverlay() { $('#historyHtmlOverlay').classList.remove('show'); }
  $('#historyHtmlClose').addEventListener('click', closeHistoryHtmlOverlay);
  $('#historyHtmlCancel').addEventListener('click', closeHistoryHtmlOverlay);
  $('#historyHtmlConfirm').addEventListener('click', () => {
    let from = $('#historyHtmlFrom').value;
    let to = $('#historyHtmlTo').value;
    if (from > to) { const t = from; from = to; to = t; }  // 逆に選ばれても黙って直す
    closeHistoryHtmlOverlay();
    downloadFromApi('/api/export-history-html?from=' + encodeURIComponent(from) +
      '&to=' + encodeURIComponent(to), 'history.html');
  });


  // ============================================================
  //  使い方（チュートリアル・整理のしかた）
  // ============================================================
  // 初回だけ自動で開く。2回目以降は「? 使い方」から。
  // 「邪魔しない程度に」という要望なので、手順を順に押させるツアーにはしない。
  // 必要な所だけ開いて読める形（折りたたみ＋3つの見出し）にしてある。

  const GUIDE_SEEN_KEY = 'yarubeki.guideSeen.v1';

  function openGuide(tab) {
    if (tab) selectGuideTab(tab);
    $('#guideOverlay').classList.add('show');
  }
  function closeGuide() {
    $('#guideOverlay').classList.remove('show');
    if ($('#guideDontShow').checked) {
      try { localStorage.setItem(GUIDE_SEEN_KEY, '1'); } catch (_) {}
    }
  }
  function selectGuideTab(name) {
    document.querySelectorAll('.guide-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.tab === name);
    });
    document.querySelectorAll('.guide-body').forEach(el => {
      el.hidden = (el.dataset.panel !== name);
    });
  }

  document.querySelectorAll('.guide-tab').forEach(b => {
    b.addEventListener('click', () => selectGuideTab(b.dataset.tab));
  });
  $('#btnGuide').addEventListener('click', () => openGuide());
  $('#guideClose').addEventListener('click', closeGuide);
  $('#guideCloseBtn').addEventListener('click', closeGuide);

  // 初回だけ自動で開く条件:
  //   まだ一度も閉じていない かつ 中身が空（＝使い始めたばかり）
  // 既に書いてある人の画面に、いまさら出しても邪魔になるだけなので出さない。
  // ===== 更新のお知らせ ==================================
  //
  // 方針:
  //   このアプリは「完全オフライン・外部通信は0件」を売りにしている。
  //   だから既定では何もしない。利用者が一度だけ聞かれて「はい」と
  //   答えたときだけ、版番号を読みに行く。
  //
  //   ★通信はブラウザ側から行う（サーバ側ではなく）。
  //     利用者に「開発者ツールで通信を確かめられます」と案内している以上、
  //     見えない場所で通信するのは筋が通らない。ここでやれば全部見える。
  //
  //   読みに行くのは版番号だけ。書いた内容は一切送らない。
  const UPDATE_CHOICE_KEY = 'updateCheck';         // 'yes' | 'no' | 未設定
  const UPDATE_SKIP_KEY = 'updateSkipVersion';     // 「この版はもういい」
  const VERSION_URL = 'https://suto648.github.io/version.json';

  function getUpdateChoice() {
    try { return localStorage.getItem(UPDATE_CHOICE_KEY); } catch (_) { return null; }
  }
  function setUpdateChoice(v) {
    try { localStorage.setItem(UPDATE_CHOICE_KEY, v); } catch (_) {}
  }

  // "1.2.10" と "1.2.9" を正しく比べる（文字列比較だと 9 > 10 になる）
  function isNewerVersion(remote, local) {
    const a = String(remote || '').split('.').map(n => parseInt(n, 10) || 0);
    const b = String(local || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  async function runUpdateCheck() {
    if (getUpdateChoice() !== 'yes') return;      // 許可が無ければ何もしない
    let mine = null;
    try {
      const who = await fetch('/api/whoami').then(r => r.json());
      mine = who && who.version;
    } catch (_) { return; }
    if (!mine) return;

    let info = null;
    try {
      const res = await fetch(VERSION_URL, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      info = j && j['yarubeki-editor'];
    } catch (_) {
      return;   // 繋がらなくても静かに諦める。使うのに支障はない
    }
    if (!info || !info.latest) return;
    if (!isNewerVersion(info.latest, mine)) return;

    let skipped = null;
    try { skipped = localStorage.getItem(UPDATE_SKIP_KEY); } catch (_) {}
    if (skipped === info.latest) return;

    const banner = $('#updateBanner');
    const text = $('#updateBannerText');
    const link = $('#updateBannerLink');
    if (!banner || !text || !link) return;
    text.textContent = '新しい版 ' + info.latest + ' が出ています（お使いの版: ' + mine + '）。'
      + (info.howto ? ' ' + info.howto : '');
    link.href = info.url || 'https://suto648.github.io/';
    banner.hidden = false;

    $('#updateBannerClose').onclick = () => {
      banner.hidden = true;
      try { localStorage.setItem(UPDATE_SKIP_KEY, info.latest); } catch (_) {}
    };
  }

  // 一度だけ聞く。
  // ★初回起動は「使い方」が開くので、そこには重ねない。2回目以降に聞く。
  function maybeAskAboutUpdates() {
    if (getUpdateChoice() !== null) return;
    let guideSeen = false;
    try { guideSeen = localStorage.getItem(GUIDE_SEEN_KEY) === '1'; } catch (_) {}
    if (!guideSeen) return;   // まだ初回。次の起動で聞く

    // ★帯で聞く。全画面で塞がない。
    const bar = $('#updateAskBar');
    if (!bar) return;
    const close = (answer) => {
      setUpdateChoice(answer);
      bar.hidden = true;
      syncUpdateCheckbox();
      if (answer === 'yes') runUpdateCheck();
    };
    $('#updateAskYes').onclick = () => close('yes');
    $('#updateAskNo').onclick = () => close('no');
    bar.hidden = false;
  }

  function syncUpdateCheckbox() {
    const box = $('#settingsUpdateCheck');
    if (box) box.checked = getUpdateChoice() === 'yes';
  }

  function initUpdateNotice() {
    // ★オンライン版（ブラウザで試す版）では、更新確認そのものが要らない。
    //   読み込むたびに最新が来るので、「新しい版があります」は出しても意味が無く、
    //   「許可したときだけ通信する」という約束の対象にもならない。
    //   設定の項目ごと隠す（押せるのに何も起きない項目を残さない）。
    if (window.__YARUBEKI_ONLINE__) {
      const field = document.querySelector('#settingsUpdateCheck');
      const group = field && field.closest('.settings-group');
      if (group) group.hidden = true;
      return;
    }

    const box = $('#settingsUpdateCheck');
    if (box) {
      syncUpdateCheckbox();
      box.addEventListener('change', () => {
        setUpdateChoice(box.checked ? 'yes' : 'no');
        try { localStorage.removeItem(UPDATE_SKIP_KEY); } catch (_) {}
        if (box.checked) runUpdateCheck();
        else { const b = $('#updateBanner'); if (b) b.hidden = true; }
      });
    }
    maybeAskAboutUpdates();
    runUpdateCheck();
  }

  function maybeOpenGuideOnFirstRun() {
    let seen = false;
    try { seen = localStorage.getItem(GUIDE_SEEN_KEY) === '1'; } catch (_) {}
    if (seen) return;
    if (content && Array.isArray(content.blocks) && content.blocks.length > 0) return;
    $('#guideDontShow').checked = true;   // 一度見たら、既定でもう出さない
    openGuide('start');
  }

  $('#btnSettings').addEventListener('click', () => openSettingsOverlay());
  $('#settingsClose').addEventListener('click', () => closeSettingsOverlay());
  $('#settingsCancel').addEventListener('click', () => closeSettingsOverlay());
  $('#settingsForm').addEventListener('submit', saveSettings);
  // 表示名を変えると、ドキュメントタイトルの薄字プレースホルダも追従させて
  // 「未入力なら表示名と同じ」であることを見た目で示す
  $('#settingsDisplayTitle').addEventListener('input', () => {
    const displayTitle = ($('#settingsDisplayTitle').value || '').trim() || DEFAULT_DOCUMENT_TITLE;
    $('#settingsDocumentTitle').placeholder = displayTitle;
  });
  $('#settingsOverlay').addEventListener('click', (e) => {
    if (e.target === $('#settingsOverlay')) closeSettingsOverlay();
  });
  $('#settingsOverlay').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettingsOverlay();
  });

  // Sticky note button & modal
  // ★付箋の追加口は画面右のボタン1つだけ。
  //   以前はツールバーにも同じものがあったが、付箋が並ぶのは右側なので
  //   「右を見ながら左上を押す」動きになっていた。外した。
  const stickyAddRight = $('#btnAddStickyRight');
  if (stickyAddRight) stickyAddRight.addEventListener('click', () => openStickyModal());

  // ★付箋の束は、画面が狭いと右端に格納され「かざすと出てくる」作りになっている。
  //   指で使う端末にはかざす操作が無いので、そのままでは二度と開けない
  //   （スマホで実際に、切れた青い帯が出たまま触れなかった）。
  //   押したら出る／もう一度押す・外を押すとしまう、を足す。
  //   かざせる端末の動きは変えない。
  (function enableStickyTapOnTouch() {
    const box = document.getElementById('stickyNotesContainer');
    if (!box) return;
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!coarse) return;

    box.addEventListener('click', (e) => {
      // 付箋そのものを押したときは、その付箋を開く動きに任せる
      if (!box.classList.contains('is-out') && !e.target.closest('.sticky-note')) {
        e.stopPropagation();
        box.classList.add('is-out');
      }
    });
    document.addEventListener('click', (e) => {
      if (box.classList.contains('is-out') && !box.contains(e.target)) {
        box.classList.remove('is-out');
      }
    });
  })();
  $('#stickyCancel').addEventListener('click', () => closeStickyModal());
  $('#stickyModal').addEventListener('click', (e) => {
    if (e.target.id === 'stickyModal') closeStickyModal();
  });
  $('#stickyColorPicker').addEventListener('click', (e) => {
    const opt = e.target.closest('.sticky-color-opt');
    if (!opt) return;
    $('#stickyColorPicker').querySelectorAll('.sticky-color-opt').forEach(el => el.classList.remove('selected'));
    opt.classList.add('selected');
  });
  $('#stickyOk').addEventListener('click', () => {
    const text = $('#stickyText').value.trim();
    if (!text) return;
    ensureStickyNotes();
    content.stickyNotes.push({
      id: 'sn_' + Date.now().toString(36),
      color: getSelectedStickyColor(),
      text: text,
      targetBlockId: pendingStickyBlockId || null
    });
    closeStickyModal();
    syncAllFromDOM();
    saveContent();
    renderStickyNotes();
  });
  $('#stickyText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#stickyOk').click(); }
    if (e.key === 'Escape') closeStickyModal();
  });

  $('#btnMainAdd').addEventListener('click', (e) => showAddMenu(e, null, null));

  // ============================================================
  //  Navigation
  // ============================================================

  const buildNavigation = createViewerNavigationRenderer({
    beforeInvoke: syncNavCollapsedStateFromDom,
    beforeRender: syncNavCollapsedStateFromDom,
    navRoot: navList,
    getBlocks: () => content.blocks,
    activateLink: (link) => setActiveNavLink(link),
    jumpToBlock: (...args) => jumpToBlock(...args),
    getTarget: (blockId) => document.getElementById(`block-${blockId}`),
    expandNavSectionOnChildClick: true,
    childScrollDelayMs: 10,
    onSectionExpanded: (block) => {
      if (block) block.collapsed = false;
    },
    isSectionCollapsed: (blockId) => navCollapsedSectionIds.has(blockId),
    getHeadingText: (block) => stripTags(block.text) || '(無題)',
    onSectionToggle: ({ block, isCollapsed }) => {
      setNavSectionCollapsed(block.id, isCollapsed);
    }
  });

  const navActivationState = { scrollSpySuppressed: false, scrollSpyTimer: null };

  // Manually set active nav link (used after click)
  const setActiveNavLink = createNavLinkActivator(navActivationState, navList, document.getElementById('sideNav'));

  // Scroll-spy for navigation (technical-investigation style)
  bindViewerScrollHandlers({
    onScrollSpy: updateScrollSpy,
    onScrollTop: updateScrollTopButton,
    throttleScrollSpyWithAnimationFrame: true
  });

  function updateScrollSpy() {
    if (navActivationState.scrollSpySuppressed) return;

    const links = navList.querySelectorAll('a');
    if (!links.length) return;

    const scrollY = window.scrollY;
    const viewH = window.innerHeight;
    const docH = document.documentElement.scrollHeight;

    // Remove all active states (nav list + today nav)
    updateRegularNavScrollSpy({
      clearOnly: true,
      onAfterClear: clearTodayNavActive
    });

    // Check if today main section is visible
    const todayMain = document.getElementById('todaySectionMain');
    if (todayMain && todayMain.style.display !== 'none') {
      const todayRect = todayMain.getBoundingClientRect();
      const trigger = viewH * 0.3;
      // If today section top is above trigger line, or we're at bottom
      if (todayRect.top <= trigger || scrollY + viewH >= docH - 30) {
        updateTodayNavActive();
        return;
      }
    }

    // Bottom of page → activate last visible link
    updateRegularNavScrollSpy({
      skipClear: true,
      scrollY,
      viewHeight: viewH,
      docHeight: docH,
    });
  }

  function clearTodayNavActive() {
    todaySection.querySelectorAll('.today-active').forEach(el => el.classList.remove('today-active'));
    todaySection.querySelectorAll('.today-label-active').forEach(el => el.classList.remove('today-label-active'));
  }

  function updateTodayNavActive() {
    clearTodayNavActive();
    const todayMain = document.getElementById('todaySectionMain');
    if (!todayMain) return;

    const subheadings = todayMain.querySelectorAll('.today-subheading[id]');
    const trigger = window.innerHeight * 0.3;
    let activeId = null;

    subheadings.forEach(sh => {
      if (sh.getBoundingClientRect().top <= trigger) {
        activeId = sh.id;
      }
    });

    if (activeId) {
      // Highlight matching nav link
      const navLink = todaySection.querySelector(`a[href="#${activeId}"]`);
      if (navLink) {
        navLink.classList.add('today-active');
        autoScrollNavWithin(document.getElementById('sideNav'), navLink);
      }
    }

    // Also expand the today section in nav if collapsed
    todaySection.classList.remove('today-collapsed');
  }

  // ============================================================
  //  Mode switching
  // ============================================================

  function setMode(viewMode) {
    isViewMode = viewMode;
    document.body.classList.toggle('view-mode', viewMode);
    document.body.classList.toggle('edit-mode', !viewMode);
    applyTheme();
    const indicator = $('#modeIndicator');
    const btn = $('#btnToggleMode');

    // ★字は span で包む（狭いときに CSS で隠すため）。index.html 側と同じ形。
    if (viewMode) {
      indicator.textContent = '閲覧モード';
      btn.innerHTML = '<i class="ti ti-pencil"></i><span class="btn-label"> 編集</span>';
    } else {
      indicator.textContent = '編集モード';
      btn.innerHTML = '<i class="ti ti-eye"></i><span class="btn-label"> 閲覧</span>';
    }

    // ★モードが変わるとツールバーの中身が増減する（編集専用の項目が出入りする）。
    //   幅の判定をやり直さないと、閲覧モードで余裕があるのに縮んだままになる。
    fitToolbar();

    // Preserve scroll position across re-render
    const scrollY = window.scrollY;
    render();
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }

  $('#btnToggleMode').addEventListener('click', () => {
    if (!isViewMode) syncAllFromDOM();
    setMode(!isViewMode);
  });

  const handleThemeToggle = createThemeToggleHandler({
    getIsLightMode: () => isLightMode,
    setIsLightMode: (nextIsLightMode) => {
      isLightMode = nextIsLightMode;
    },
    onToggle: (nextIsLightMode) => {
      localStorage.setItem('theme', nextIsLightMode ? 'light' : 'dark');
    },
    applyTheme
  });

  bindViewerUtilityButtons({
    themeButton: $('#btnThemeToggleFab'),
    topButton: $('#btnScrollTop'),
    onThemeToggle: handleThemeToggle
  });

  // Export as self-contained HTML (DOM snapshot approach)
  $('#btnExportHtml').addEventListener('click', async () => {
    syncAllFromDOM();
    await saveContent();

    // 閲覧モードで再レンダリングして今の見た目をキャプチャ
    const wasViewMode = isViewMode;
    if (!wasViewMode) setMode(true);

    // 本日更新セクション・プレビューが非同期なので少し待つ
    await new Promise(r => setTimeout(r, 500));

    // CSSをサーバーから取得
    const cssRes = await fetch('/style.css');
    const css = await cssRes.text();

    // highlight.js CSSをインラインで取得
    let hljsCss = '';
    let hljsScriptBundle = '';
    try {
      const hljsLink = document.querySelector('link[href*="highlight"]');
      if (hljsLink) {
        const r = await fetch(hljsLink.href);
        hljsCss = await r.text();
      }
    } catch (_) {}

    try {
      const scriptEls = Array.from(document.querySelectorAll('script[src*="highlight"]'));
      if (scriptEls.length) {
        const sources = await Promise.all(scriptEls.map(async scriptEl => {
          const res = await fetch(scriptEl.src);
          return res.text();
        }));
        hljsScriptBundle = sources.join('\n');
      }
    } catch (_) {}

    let todayData = null;
    try {
      todayData = await loadLegacyTodayData();
    } catch (_) {}

    const payload = await getStandaloneExportPayload(todayData);
    const html = buildStandaloneHtml(payload, css, hljsCss, hljsScriptBundle);

    // ダウンロード
    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (getDocumentTitle() || 'ドキュメント') + '（閲覧用）.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // 元のモードに戻す
    if (!wasViewMode) setMode(false);
    showToast('HTMLをエクスポートしました', 2000);
  });

  // ============================================================
  //  Today's updates section
  // ============================================================

  async function loadLegacyTodayData() {
    const res = await fetch('/api/legacy-today');
    return res.json();
  }

  function hasTodayData(data) {
    return !!data && data.totalLines !== 0 && data.totalGroups !== 0;
  }

  function escapeHtmlText(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderTodayInlineHtml(text) {
    const s = String(text == null ? '' : text);
    return s.replace(/(<\/?(?:code|b|strong)>)|([^<]+|<)/g, (m, tag, rest) => {
      if (tag) return tag;
      return escapeHtmlText(rest);
    });
  }

  // 本日更新で画像マーカー([画像#id])を実際のサムネイルに変換する。
  // src の解決は window.__resolveTodayImageSrc(id) に委ねる。この関数は
  //   ・ライブ編集画面 … init() で content.blocks を引くよう登録
  //   ・共有HTMLの閲覧ビューア … 埋め込み blocks を引くよう登録
  // の両方で登録される。共有HTMLでは画像は payload に1回だけ埋め込まれ、
  // 本日更新セクションはそれを参照するだけなのでファイルは重くならない。
  // 未登録・未解決なら「🖼 画像」ラベルにフォールバックする。
  function renderTodayImageHtml(blockId) {
    let src = '';
    try {
      if (blockId && typeof window !== 'undefined'
          && typeof window.__resolveTodayImageSrc === 'function') {
        src = window.__resolveTodayImageSrc(blockId) || '';
      }
    } catch (_) { /* fall back to label */ }
    if (!src) return `<div class="today-content today-image-missing">🖼 画像</div>`;
    const safe = String(src).replace(/"/g, '&quot;');
    return `<img class="today-image" src="${safe}" alt="画像" loading="lazy">`;
  }

  function normalizeTodayDisplayText(text) {
    return String(text == null ? '' : text)
      .replace(/&#(?:x0*9|9);/gi, '\t')
      .replace(/(?:&nbsp;|&#160;|&#x0*a0;)/gi, ' ')
      .replace(/\u00a0/g, ' ');
  }

  // Render a run of "| a | b |" snapshot lines as a compact table for 本日更新.
  // First line is treated as the header row.
  function renderTodayTableHtml(rowLines) {
    if (!rowLines || !rowLines.length) return '';
    const parsed = rowLines.map(splitMarkdownTableRow);
    const colCount = parsed.reduce((max, cells) => Math.max(max, cells.length), 0);
    if (!colCount) return '';
    const cellHtml = (cells, idx) => escapeHtmlText(normalizeTodayDisplayText(cells[idx] != null ? cells[idx] : ''));
    const [headerCells, ...bodyRows] = parsed;
    let out = '<table class="today-table"><thead><tr>';
    for (let c = 0; c < colCount; c++) out += `<th>${cellHtml(headerCells, c)}</th>`;
    out += '</tr></thead>';
    if (bodyRows.length) {
      out += '<tbody>';
      for (const row of bodyRows) {
        out += '<tr>';
        for (let c = 0; c < colCount; c++) out += `<td>${cellHtml(row, c)}</td>`;
        out += '</tr>';
      }
      out += '</tbody>';
    }
    return out + '</table>';
  }

  function buildTodayHeaderHtml(displayDate, totalGroups, variant) {
    const isNav = variant === 'nav';
    // Nav: clicking the header body jumps to the main today section,
    // only the ▼ toggle collapses. Main: whole header toggles collapse.
    const headerClick = isNav
      ? "scrollToTodayMain('todaySectionMain')"
      : "this.parentElement.classList.toggle('today-collapsed')";
    const toggleAttr = isNav
      ? " onclick=\"event.stopPropagation(); this.closest('.today-section').classList.toggle('today-collapsed')\""
      : '';
    return [
      `<div class="today-header${isNav ? ' today-header-nav' : ''}" onclick="${headerClick}">`,
      `<span class="today-toggle" aria-hidden="true"${toggleAttr}>▼</span>`,
      '<div class="today-header-copy">',
      '<div class="today-header-eyebrow">本日更新</div>',
      `<div class="today-header-date">${escapeHtmlText(displayDate)}</div>`,
      '</div>',
      `<small class="today-badge" aria-label="${totalGroups}件">`,
      `<span class="today-badge-count">${totalGroups}</span>`,
      '<span class="today-badge-label">件</span>',
      '</small>',
      '</div>'
    ].join('');
  }

  function buildTodayNavHtml(data, displayDate) {
    if (!hasTodayData(data)) return '';

    let html = '';
    html += buildTodayHeaderHtml(displayDate, data.totalGroups, 'nav');

    html += `<div class="today-body">`;

    let prevSection = null;
    let navSubIdx = 0;
    for (const group of data.groups || []) {
      if (group.section !== prevSection) {
        if (prevSection !== null) html += `<div class="today-spacer"></div>`;
        html += `<div class="today-section-label">${escapeHtmlText(group.section)}</div>`;
        prevSection = group.section;
      }

      if (group.subheading) {
        const todayMainId = `today-main-${navSubIdx}`;
        navSubIdx++;
        html += `<div class="today-subheading">`;
        html += `<span class="today-quote">&gt;&gt;</span> `;
        if (group.isNew) html += `<span class="new-badge">NEW</span> `;
        html += `<a class="today-jump" href="#${todayMainId}" onclick="scrollToTodayMain('${todayMainId}'); return false;">`;
        html += `<b>${escapeHtmlText(group.subheading)}</b>`;
        html += `</a>`;
        html += `</div>`;
      }
    }

    html += `</div>`;
    return html;
  }

  function buildTodayMainHtml(data, displayDate) {
    if (!hasTodayData(data)) return '';

    let html = '';
    html += buildTodayHeaderHtml(displayDate, data.totalGroups, 'main');

    html += `<div class="today-body">`;

    let prevSection = null;
    let mainSubIdx = 0;
    for (const group of data.groups || []) {
      if (group.section !== prevSection) {
        if (prevSection !== null) html += `<div class="today-spacer"></div>`;
        html += `<div class="today-section-label">${escapeHtmlText(group.section)}</div>`;
        prevSection = group.section;
      }

      if (group.subheading) {
        const todayMainId = `today-main-${mainSubIdx}`;
        mainSubIdx++;
        html += `<div class="today-subheading" id="${todayMainId}">`;
        html += `<span class="today-quote">&gt;&gt;</span> `;
        if (group.isNew) html += `<span class="new-badge">NEW</span> `;
        html += `<b>${escapeHtmlText(group.subheading)}</b>`;
        html += `</div>`;
      }

      let inCodeFence = false;
      let codeLang = '';
      let tableRows = null; // collecting rows between |TABLE_START| and |TABLE_END|
      for (const item of group.items || []) {
        if (/^```/.test(item)) {
          inCodeFence = !inCodeFence;
          if (inCodeFence) {
            codeLang = item.replace(/^```/, '').trim();
            const langClass = getHighlightLanguageClass(codeLang);
            html += `<pre class="today-code"><code class="${langClass}">`;
          } else {
            html += `</code></pre>`;
            codeLang = '';
          }
          continue;
        }
        if (inCodeFence) {
          html += escapeHtmlText(item) + '\n';
          continue;
        }
        if (item === '|TABLE_START|') {
          tableRows = [];
          continue;
        }
        if (item === '|TABLE_END|') {
          if (tableRows) { html += renderTodayTableHtml(tableRows); tableRows = null; }
          continue;
        }
        if (tableRows !== null) {
          if (/^\s*\|/.test(item)) { tableRows.push(item); continue; }
          // Unterminated run: flush what we have and fall through to normal handling
          html += renderTodayTableHtml(tableRows);
          tableRows = null;
        }
        if (item === '|BLANK|') {
          html += `<div class="today-blank"></div>`;
          continue;
        }
        if (item === '|PARAGRAPH_BREAK|') {
          html += `<div class="today-paragraph-break"></div>`;
          continue;
        }
        const imgMatch = item.match(/^\[画像(?:#(.+))?\]$/);
        if (imgMatch) {
          html += renderTodayImageHtml(imgMatch[1]);
          continue;
        }
        const displayItem = normalizeTodayDisplayText(item);
        if (/^\s*\|/.test(item)) {
          html += `<div class="today-table-line">${escapeHtmlText(displayItem)}</div>`;
          continue;
        }
        const indent = group.subheading ? 'today-content-sub' : 'today-content';
        html += `<div class="${indent}">${renderTodayInlineHtml(displayItem)}</div>`;
      }
      if (tableRows && tableRows.length) html += renderTodayTableHtml(tableRows);
    }

    html += `</div>`;
    return html;
  }

  function renderTodayContainer(container, options) {
    if (!container) return false;
    const data = options && options.data;
    if (!hasTodayData(data)) {
      container.style.display = 'none';
      return false;
    }

    container.style.display = options && options.visible === false ? 'none' : '';
    container.innerHTML = options && options.html ? options.html : '';

    if (options && Object.prototype.hasOwnProperty.call(options, 'collapsed')) {
      container.classList.toggle('today-collapsed', !!options.collapsed);
    }

    if (options && typeof options.afterRender === 'function') {
      options.afterRender(container);
    }

    return true;
  }

  function renderTodayPanels(options) {
    const panelOptions = options || {};
    const data = panelOptions.data;
    const displayText = panelOptions.displayText || '';

    renderTodayContainer(panelOptions.navContainer, {
      data,
      visible: panelOptions.navVisible,
      html: buildTodayNavHtml(data, displayText),
      collapsed: panelOptions.navCollapsed
    });

    renderTodayContainer(panelOptions.mainContainer, {
      data,
      visible: panelOptions.mainVisible,
      html: buildTodayMainHtml(data, displayText),
      collapsed: panelOptions.mainCollapsed,
      afterRender: panelOptions.afterMainRender || applyTodayMainHighlighting
    });
  }

  function createTodayPanelsRenderer(options) {
    const panelOptions = options || {};
    return function(dataOverride) {
      const hasOverride = typeof dataOverride !== 'undefined';
      const data = hasOverride
        ? dataOverride
        : (typeof panelOptions.getData === 'function' ? panelOptions.getData() : panelOptions.data);

      return renderTodayPanels({
        data,
        displayText: typeof panelOptions.getDisplayText === 'function' ? panelOptions.getDisplayText() : panelOptions.displayText,
        navContainer: typeof panelOptions.getNavContainer === 'function' ? panelOptions.getNavContainer() : panelOptions.navContainer,
        navVisible: typeof panelOptions.getNavVisible === 'function' ? panelOptions.getNavVisible() : panelOptions.navVisible,
        navCollapsed: typeof panelOptions.getNavCollapsed === 'function' ? panelOptions.getNavCollapsed() : panelOptions.navCollapsed,
        mainContainer: typeof panelOptions.getMainContainer === 'function' ? panelOptions.getMainContainer() : panelOptions.mainContainer,
        mainVisible: typeof panelOptions.getMainVisible === 'function' ? panelOptions.getMainVisible() : panelOptions.mainVisible,
        mainCollapsed: typeof panelOptions.getMainCollapsed === 'function' ? panelOptions.getMainCollapsed() : panelOptions.mainCollapsed,
        afterMainRender: panelOptions.afterMainRender
      });
    };
  }

  function applyTodayMainHighlighting(rootEl) {
    if (!rootEl || typeof hljs === 'undefined') return;
    rootEl.querySelectorAll('.today-code code').forEach(block => {
      try { hljs.highlightElement(block); } catch (_) {}
    });
  }

  const renderTodaySections = createTodayPanelsRenderer({
    getDisplayText: todayDisplay,
    navContainer: todaySection,
    mainContainer: todaySectionMain,
    afterMainRender: applyTodayMainHighlighting
  });

  async function refreshTodaySections(todayData) {
    try {
      const data = todayData || await loadLegacyTodayData();

      renderTodaySections(data);
      addTodayPreviews(data);
      return data;
    } catch (err) {
      todaySection.style.display = 'none';
      todaySectionMain.style.display = 'none';
      return null;
    }
  }

  // Find a block ID by matching text (for jump links)
  function findBlockIdByText(searchText, blocks) {
    const list = blocks || content.blocks;
    for (const b of list) {
      if (b.type === 'heading') {
        const bText = stripTags(b.text || '');
        if (bText.includes(searchText) || searchText.includes(bText)) return b.id;
      }
      if (b.type === 'section' && b.children) {
        const found = findBlockIdByText(searchText, b.children);
        if (found) return found;
      }
    }
    return null;
  }

  function expandLiveSectionBlock(parentBlockId) {
    if (!parentBlockId) return;
    const found = findBlockList(parentBlockId, content.blocks);
    if (!found) return;
    const sectionBlock = found.list[found.index];
    if (!sectionBlock || !sectionBlock.collapsed) return;
    sectionBlock.collapsed = false;
    refreshSaveStatus();
  }

  const liveJumpHandlers = createViewerJumpHandlers({
    getBlockTarget: (blockId) => document.getElementById(`block-${blockId}`),
    onExpanded: (parentBlockId) => {
      expandLiveSectionBlock(parentBlockId);
    },
    todayContainer: todaySectionMain
  });
  const jumpToBlock = liveJumpHandlers.jumpToBlock;
  const scrollToTodayMain = liveJumpHandlers.scrollToTodayMain;
  exposeViewerJumpHandlers({
    jumpToBlock,
    scrollToTodayMain
  });

  // ============================================================
  //  History viewer
  // ============================================================

  $('#btnHistory').addEventListener('click', () => {
    $('#historyOverlay').classList.add('show');
    loadLegacySnapshots().then(snapshots => {
      if (snapshots.length > 0) {
        const last = snapshots[snapshots.length - 1];
        // Default end = latest snapshot; default start = 7 days before today
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        const pad = n => String(n).padStart(2, '0');
        const fromDefault = `${oneWeekAgo.getFullYear()}-${pad(oneWeekAgo.getMonth() + 1)}-${pad(oneWeekAgo.getDate())}`;
        // Only set if not already populated by the user
        if (!$('#historyFrom').value) $('#historyFrom').value = fromDefault;
        if (!$('#historyTo').value) $('#historyTo').value = `${last.slice(0,4)}-${last.slice(4,6)}-${last.slice(6,8)}`;
      }
    });
  });

  $('#historyClose').addEventListener('click', () => {
    $('#historyOverlay').classList.remove('show');
  });

  $('#historyOverlay').addEventListener('click', (e) => {
    if (e.target === $('#historyOverlay')) {
      $('#historyOverlay').classList.remove('show');
    }
  });

  $('#historyLoad').addEventListener('click', async () => {
    const from = $('#historyFrom').value.replace(/-/g, '');
    const to = $('#historyTo').value.replace(/-/g, '');
    if (!from || !to) return;

    const results = $('#historyResults');
    results.innerHTML = '<p style="color:var(--fg3)">読み込み中...</p>';

    try {
      const data = await loadLegacyRange(from, to);

      if (!data.combined && data.days.length === 0) {
        results.innerHTML = '<p style="color:var(--fg3)">この期間にスナップショットがありません。</p>';
        return;
      }

      let html = '';

      // Combined summary
      if (data.combined) {
        html += `<div class="diff-combined">`;
        html += `<h3 style="color:var(--heading);margin-bottom:8px">${formatDateLabel(data.combined.from)} → ${formatDateLabel(data.combined.to)}</h3>`;
        html += `<p style="color:var(--fg2);margin-bottom:12px">合計: <strong>${data.combined.totalLines}</strong> 行追加</p>`;

        data.combined.groups.forEach(g => {
          html += `<div class="diff-group" style="margin-bottom:8px">`;
          html += `<div class="diff-group-title">${escapeHtml(g.key)} (${g.count} lines)</div>`;
          if (g.isNew) {
            html += `<span class="new-badge">NEW</span> `;
          }
          html += renderDiffItems(g.items, 12);
          html += `</div>`;
        });
        html += `</div>`;
      }

      // Day-by-day
      if (data.days.length > 0) {
        html += `<hr style="border-color:var(--border);margin:16px 0">`;
        html += `<h3 style="color:var(--heading);margin-bottom:12px">日別内訳</h3>`;

        data.days.forEach(day => {
          html += `<details class="day-details" style="margin-bottom:8px">`;
          html += `<summary style="cursor:pointer;color:var(--fg);padding:4px 0;font-weight:600">=== ${formatDateLabel(day.date)} === (${day.totalLines} lines)</summary>`;
          html += `<div style="padding-left:12px;margin-top:4px">`;

          if (day.groups.length === 0) {
            html += `<p style="color:var(--fg3);font-size:12px">(変更なし)</p>`;
          } else {
            day.groups.forEach(g => {
              html += `<div class="diff-group" style="margin-bottom:6px">`;
              html += `<div class="diff-group-title" style="font-size:11px">${escapeHtml(g.key)} (${g.count} lines)</div>`;
              html += renderDiffItems(g.items, 11);
              html += `</div>`;
            });
          }

          html += `</div></details>`;
        });
      }

      if (!html) html = '<p style="color:var(--fg3)">この期間に変更はありません。</p>';
      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = `<p style="color:var(--bad)">エラー: ${err.message}</p>`;
    }
  });

  function renderDiffItems(items, fontSize) {
    let h = '';
    let inCode = false;
    for (const item of items) {
      if (item === '|BLANK|') {
        h += `<div class="today-blank"></div>`;
        continue;
      }
      if (item === '|PARAGRAPH_BREAK|') {
        h += `<div class="today-paragraph-break"></div>`;
        continue;
      }
      if (item === '|TABLE_START|' || item === '|TABLE_END|') continue;
      if (/^```/.test(item)) {
        inCode = !inCode;
        if (inCode) {
          h += `<pre class="today-code" style="font-size:${fontSize}px">`;
        } else {
          h += `</pre>`;
        }
        continue;
      }
      if (inCode) {
        h += escapeHtml(item) + '\n';
        continue;
      }
      if (/^\[画像(?:#.+)?\]$/.test(item)) {
        h += `<div class="diff-item added" style="font-size:${fontSize}px;padding:2px 8px">🖼 画像</div>`;
        continue;
      }
      h += `<div class="diff-item added" style="font-size:${fontSize}px;padding:2px 8px">${escapeHtml(item)}</div>`;
    }
    if (inCode) h += `</pre>`;
    return h;
  }

  function formatDateLabel(yyyyMMdd) {
    return `${yyyyMMdd.slice(0,4)}/${yyyyMMdd.slice(4,6)}/${yyyyMMdd.slice(6,8)}`;
  }

  // MD export (history diff, not full content)
  $('#historyExportMd').addEventListener('click', () => {
    const from = $('#historyFrom').value.replace(/-/g, '');
    const to = $('#historyTo').value.replace(/-/g, '');
    if (!from || !to) {
      showToast('日付範囲を指定してください', 2000);
      return;
    }
    downloadFromApi(
      `/api/export-history-md?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&mode=range`,
      'history.md');
  });

  const btnReorgMode = $('#btnReorgMode');
  if (btnReorgMode) btnReorgMode.addEventListener('click', toggleReorgMode);

  $('#btnResetTodayBaseline').addEventListener('click', async () => {
    if (!confirm('現在の状態を本日更新の新しい baseline に設定します。\n今日の差分表示はリセットされます。')) return;
    try {
      syncAllFromDOM();
      await saveContent({ force: true });
      await resetTodayBaseline();
      $('#historyResults').innerHTML = '<p style="color:var(--fg3)">本日更新をリセットしました。</p>';
      showToast('本日更新をリセットしました', 1800);
    } catch (err) {
      showToast(`リセット失敗: ${err.message}`, 2500);
    }
  });

  // ============================================================
  //  Sticky Notes (付箋)
  // ============================================================

  function ensureStickyNotes() {
    if (!content.stickyNotes) content.stickyNotes = [];
  }

  // Find the block closest to the current viewport top
  function getBlockAtCurrentScroll() {
    const blocks = blocksContainer.querySelectorAll('[data-block-id]');
    const toolbarOffset = 60;
    let best = null;
    for (const el of blocks) {
      const rect = el.getBoundingClientRect();
      if (rect.top <= toolbarOffset + 40) best = el.dataset.blockId;
      else break;
    }
    return best;
  }

  let pendingStickyBlockId = null;

  function openStickyModal() {
    const modal = $('#stickyModal');
    const textInput = $('#stickyText');
    const picker = $('#stickyColorPicker');

    // Capture current position before showing modal
    pendingStickyBlockId = getBlockAtCurrentScroll();

    textInput.value = '';
    picker.querySelectorAll('.sticky-color-opt').forEach((el, i) => {
      el.classList.toggle('selected', i === 0);
    });
    delete modal.dataset.editId;

    modal.style.display = 'flex';
    textInput.focus();
  }

  function closeStickyModal() {
    $('#stickyModal').style.display = 'none';
  }

  function getSelectedStickyColor() {
    const sel = $('#stickyColorPicker .sticky-color-opt.selected');
    return sel ? sel.dataset.color : '#f7c948';
  }

  const STICKY_COLORS = ['#f7c948','#f06595','#51cf66','#339af0','#cc5de8','#ff8a4c'];

  const renderStickyNotes = createStickyNotesRenderer({
    beforeRender: ensureStickyNotes,
    container: $('#stickyNotesContainer'),
    getStickyNotes: () => content.stickyNotes,
    getTodayColor: () => localStorage.getItem('todayStickyColor') || '#339af0',
    buildSticky: buildStickyEl
  });

  function buildStickyEl(note, isToday) {
    const el = buildStickyNoteElement(note, {
      isToday,
      getTitle: ({ note: stickyNote, isToday: todaySticky }) => stickyNote.text + (todaySticky ? '\nクリックで本日更新セクションへ' : '\nクリックでジャンプ\nドラッグで並べ替え'),
      shouldActivate: ({ event }) => {
        return !event.target.closest('.sticky-peel')
          && !event.target.closest('.sticky-ribbon')
          && !event.target.closest('.sticky-inline-picker');
      },
      onActivate: createStickyActivationHandler(note, {
        isToday,
        getTodayMainId: () => {
          return getVisibleElementId(todaySectionMain);
        },
        scrollToTodayMain,
        jumpToBlock,
        onMiss: scrollToPageTop
      })
    });

    // --- Drag handle (user notes only, edit mode) ---
    if (!isToday) {
      el.draggable = true;
      el.dataset.stickyId = note.id;
      el.addEventListener('dragstart', (e) => {
        el.classList.add('sticky-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', note.id);
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('sticky-dragging');
        document.querySelectorAll('.sticky-note.sticky-dragover').forEach(n => n.classList.remove('sticky-dragover'));
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('sticky-dragover');
      });
      el.addEventListener('dragleave', () => {
        el.classList.remove('sticky-dragover');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('sticky-dragover');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === note.id) return;
        ensureStickyNotes();
        const notes = content.stickyNotes;
        const fromIdx = notes.findIndex(n => n.id === draggedId);
        const toIdx = notes.findIndex(n => n.id === note.id);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = notes.splice(fromIdx, 1);
        notes.splice(toIdx, 0, moved);
        syncAllFromDOM();
        saveContent();
        renderStickyNotes();
      });
    }

    // --- Ribbon (color change) ---
    const ribbon = document.createElement('div');
    ribbon.className = 'sticky-ribbon';
    ribbon.style.background = darkenColor(note.color, 0.3);
    ribbon.title = '色を変更';
    ribbon.addEventListener('click', (e) => {
      e.stopPropagation();
      // Toggle inline picker
      const existing = el.querySelector('.sticky-inline-picker');
      if (existing) { existing.remove(); el.style.zIndex = ''; return; }
      // Close any other open pickers and reset z-index
      document.querySelectorAll('.sticky-inline-picker').forEach(p => { p.parentElement.style.zIndex = ''; p.remove(); });
      // ピッカーを開いた付箋を兄弟要素より前面に出す
      // （.sticky-notes-container は overflow:visible のため z-index が有効）
      // ピッカーは付箋内部の子要素なので、親の z-index を上げないと
      // 後続の付箋要素に隠れて点滅する競合が起きる
      el.style.zIndex = '900';
      const picker = document.createElement('div');
      picker.className = 'sticky-inline-picker';
      for (const c of STICKY_COLORS) {
        const opt = document.createElement('span');
        opt.className = 'sticky-color-opt' + (c === note.color ? ' selected' : '');
        opt.style.background = c;
        opt.dataset.color = c;
        opt.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (isToday) {
            localStorage.setItem('todayStickyColor', c);
          } else {
            note.color = c;
            saveContent();
          }
          picker.remove();
          el.style.zIndex = '';
          renderStickyNotes();
        });
        picker.appendChild(opt);
      }
      el.appendChild(picker);
      // Close on outside click
      const closeHandler = (ev) => {
        if (!picker.contains(ev.target) && ev.target !== ribbon) {
          picker.remove();
          el.style.zIndex = '';
          document.removeEventListener('click', closeHandler, true);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
    });
    el.appendChild(ribbon);

    // --- Peel-corner delete (user notes only, edit mode) ---
    if (!isToday) {
      const peel = document.createElement('div');
      peel.className = 'sticky-peel';
      peel.title = '剥がす';
      peel.addEventListener('click', (e) => {
        e.stopPropagation();
        // Peel-off animation then delete
        el.style.transition = 'transform 0.35s ease, opacity 0.3s ease';
        el.style.transform = 'rotate(8deg) translateX(30px) scale(0.7)';
        el.style.opacity = '0';
        setTimeout(() => {
          ensureStickyNotes();
          content.stickyNotes = content.stickyNotes.filter(n => n.id !== note.id);
          syncAllFromDOM();
          saveContent();
          renderStickyNotes();
        }, 300);
      });
      el.appendChild(peel);
    }

    return el;
  }

  function darkenColor(hex, amount) {
    const num = parseInt(hex.replace('#',''), 16);
    const r = Math.max(0, Math.round(((num >> 16) & 0xff) * (1 - amount)));
    const g = Math.max(0, Math.round(((num >> 8) & 0xff) * (1 - amount)));
    const b = Math.max(0, Math.round((num & 0xff) * (1 - amount)));
    return `rgb(${r},${g},${b})`;
  }

  function findBlock(blockId, blocks) {
    for (const b of blocks) {
      if (b.id === blockId) return b;
      if (b.type === 'section' && b.children) {
        const found = findBlock(blockId, b.children);
        if (found) return found;
      }
    }
    return null;
  }

  // ============================================================
  //  Init
  // ============================================================

  // ── 画像ライトボックス（本日更新のサムネイルをクリックで拡大、外側/Escで縮小）──
  let imageLightboxEl = null;

  function closeImageLightbox() {
    if (!imageLightboxEl) return;
    imageLightboxEl.classList.remove('show');
    const el = imageLightboxEl;
    imageLightboxEl = null;
    setTimeout(() => { if (el && el.parentNode) el.parentNode.removeChild(el); }, 180);
  }

  function openImageLightbox(src) {
    if (!src) return;
    closeImageLightbox();
    const overlay = document.createElement('div');
    overlay.className = 'image-lightbox';
    // 背景（画像の外側）クリックで閉じる
    overlay.addEventListener('click', closeImageLightbox);
    const img = document.createElement('img');
    img.className = 'image-lightbox-img';
    img.src = src;
    img.alt = '画像（拡大）';
    // 画像そのもののクリックでは閉じない（外側だけ）
    img.addEventListener('click', (e) => e.stopPropagation());
    overlay.appendChild(img);
    document.body.appendChild(overlay);
    // トランジションを効かせるため次フレームで show
    requestAnimationFrame(() => overlay.classList.add('show'));
    imageLightboxEl = overlay;
  }

  // 本日更新の画像マーカーを実画像srcへ解決する（ライブ編集画面用）
  function registerLiveTodayImageResolver() {
    window.__resolveTodayImageSrc = (blockId) => {
      try {
        const found = findBlockList(blockId, content.blocks);
        if (found) {
          const b = found.list[found.index];
          if (b && b.type === 'image' && b.src) return b.src;
        }
      } catch (_) {}
      return '';
    };
  }

  function initImageLightbox() {
    // イベント委譲：本日更新パネルは再描画されるので document で拾う
    document.addEventListener('click', (e) => {
      const img = e.target.closest && e.target.closest('img.today-image');
      if (!img) return;
      e.preventDefault();
      openImageLightbox(img.getAttribute('src'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && imageLightboxEl) closeImageLightbox();
    });
  }

  async function init() {
    await loadContent();
    applyTheme();
    updateScrollTopButton();
    // 初期状態ですべてのセクションを閉じる
    collapseAllSections(content.blocks);
    lastSavedContentJson = serializeContentForSave();
    refreshSaveStatus();
    setMode(isViewMode);
    updateUndoRedoButtons();
    renderStickyNotes();
    initSearch();
    loadReorgModeState();
    startAutosave();
    refreshSyncBaseline();   // 現在の共有データの版を基準に設定
    startSyncWatch();        // 別PCの更新を監視して自動反映する
    registerLiveTodayImageResolver(); // 本日更新の画像マーカーを実画像に解決
    initImageLightbox();     // 本日更新の画像をクリックで拡大
    maybeOpenGuideOnFirstRun(); // 使い始めのときだけ「使い方」を出す
    initUpdateNotice();         // 更新のお知らせ（許可したときだけ通信する）
  }

  init();

})();
