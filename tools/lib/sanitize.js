/*
 * Allowlist HTML sanitizer for GitHub-rendered issue and comment HTML.
 *
 * Pure functions with no Node-specific dependencies (only the WHATWG URL
 * class), so the same file can run at build time and in the browser.
 * In Node it is exported through module.exports; in a browser it is exposed
 * as window.ForumSanitize.
 *
 *   sanitizeHtml(html, ctx) -> safe HTML string
 *     ctx.org            GitHub org whose issue links may be rewritten (default 'draykerdk')
 *     ctx.threadExists   (repo, num) -> slug | null; when a slug is returned,
 *                        https://github.com/<org>/<repo>/issues/<num> becomes /t/<slug>/<num>/
 *     ctx.rawBody        raw markdown, used to recover user-attachment ids for
 *                        expiring private-user-images URLs
 *   htmlToText(html) -> plain text, whitespace collapsed
 */
(function (root) {
  'use strict';

  const BASE = 'https://github.com/';
  const MAX_DEPTH = 32;

  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

  const DROP_CONTENT = words('script style iframe frame frameset object embed template noscript svg math form textarea select option button link meta base audio video source canvas');
  // Elements whose content the HTML tokenizer reads as raw text (no tags inside).
  const RAW_TEXT = words('script style iframe noscript noembed noframes xmp plaintext');
  // Elements whose content is text with entities decoded but no tags.
  const RCDATA = words('textarea title');
  const VOID = words('area base basefont bgsound br col embed frame hr image img input keygen link meta param source track wbr');
  const BLOCK = words('p div ul ol table pre blockquote h1 h2 h3 h4 h5 h6 hr details');
  const TEXT_BREAK = words('p br div li ul ol table tr pre blockquote h1 h2 h3 h4 h5 h6 hr details summary');
  const TEXT_SPACE = words('td th img');

  const ALLOWED = {
    p: 'p', br: 'br', hr: 'hr',
    h1: 'h3', h2: 'h3', h3: 'h4', h4: 'h5', h5: 'h6', h6: 'h6',
    a: 'a', strong: 'strong', em: 'em', b: 'b', i: 'i', del: 'del', s: 's', ins: 'ins',
    sup: 'sup', sub: 'sub', kbd: 'kbd', code: 'code', pre: 'pre', blockquote: 'blockquote',
    ul: 'ul', ol: 'ol', li: 'li', table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr',
    th: 'th', td: 'td', img: 'img', details: 'details', summary: 'summary', span: 'span',
    div: 'div', input: 'input'
  };
  const HEADING = /^h[1-6]$/;
  const CLASS_OK = /^(pl-[a-z0-9]+|task-list-item|task-list-item-checkbox|contains-task-list|user-mention|issue-link)$/;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  const WS = /[\t\n\f\r ]/;

  const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
    trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
    sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
    bull: '•', middot: '·', deg: '°', plusmn: '±', times: '×', divide: '÷',
    euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
    shy: '­', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', micro: 'µ',
    frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³',
    larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', rArr: '⇒',
    lArr: '⇐', hArr: '⇔', ne: '≠', le: '≤', ge: '≥', infin: '∞',
    minus: '−', asymp: '≈', prime: '′', Prime: '″', dagger: '†', Dagger: '‡',
    permil: '‰', lsaquo: '‹', rsaquo: '›', ensp: ' ', emsp: ' ', thinsp: ' ',
    zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', check: '✓', cross: '✗', star: '☆',
    hearts: '♥', Tab: '\t', NewLine: '\n', excl: '!', num: '#', dollar: '$', percnt: '%', lpar: '(',
    rpar: ')', ast: '*', plus: '+', comma: ',', period: '.', sol: '/', colon: ':', semi: ';', equals: '=',
    quest: '?', commat: '@', lsqb: '[', bsol: '\\', rsqb: ']', Hat: '^', lowbar: '_', grave: '`',
    lcub: '{', verbar: '|', vert: '|', rcub: '}', tilde: '˜', circ: 'ˆ', acute: '´',
    cedil: '¸', uml: '¨', macr: '¯', not: '¬', brvbar: '¦', curren: '¤',
    Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
    AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
    Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ',
    Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
    Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ',
    szlig: 'ß', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä',
    aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê',
    euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', eth: 'ð',
    ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
    oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý',
    thorn: 'þ', yuml: 'ÿ', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š',
    Yuml: 'Ÿ', fnof: 'ƒ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
    lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω', Delta: 'Δ',
    Sigma: 'Σ', Omega: 'Ω'
  };
  // Named references a browser also accepts without the trailing semicolon.
  const LEGACY = words('amp lt gt quot nbsp copy reg');

  function decodeEntities(text, inAttribute) {
    if (text.indexOf('&') < 0) return text;
    return text.replace(/&(#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g,
      (match, _all, hex, dec, name, semi, offset, whole) => {
        if (hex !== undefined || dec !== undefined) {
          const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
          if (!(code > 0) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
          return String.fromCodePoint(code);
        }
        if (semi && Object.prototype.hasOwnProperty.call(NAMED, name)) return NAMED[name];
        if (!semi && LEGACY.has(name)) {
          const next = whole.charAt(offset + match.length);
          if (inAttribute && /[=A-Za-z0-9]/.test(next)) return match;
          return NAMED[name];
        }
        return match;
      });
  }

  const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');
  const stripNulls = (s) => s.replace(/\u0000/g, '');

  /*
   * Tokenizer. Calls emit(token) with
   *   { type: 'text', text }                       decoded text
   *   { type: 'start', name, attrs: Map, selfClosing }
   *   { type: 'end', name }
   * Comments, doctypes, processing instructions and CDATA are dropped.
   * A tag cut off by the end of input is dropped, as a browser would.
   */
  function tokenize(input, emit) {
    const s = String(input == null ? '' : input);
    const n = s.length;
    let i = 0;
    let textStart = 0;

    const flushText = (end) => {
      if (end > textStart) emit({ type: 'text', text: decodeEntities(s.slice(textStart, end), false) });
    };
    const skipTo = (needle, from) => {
      const at = s.indexOf(needle, from);
      return at < 0 ? n : at + needle.length;
    };

    while (i < n) {
      const lt = s.indexOf('<', i);
      if (lt < 0) break;
      const c = s.charAt(lt + 1);

      if (c === '!') {
        flushText(lt);
        if (s.startsWith('<!--', lt)) {
          if (s.startsWith('<!-->', lt)) i = lt + 5;
          else if (s.startsWith('<!--->', lt)) i = lt + 6;
          else {
            const a = s.indexOf('-->', lt + 4);
            const b = s.indexOf('--!>', lt + 4);
            if (a < 0 && b < 0) i = n;
            else if (b >= 0 && (a < 0 || b < a)) i = b + 4;
            else i = a + 3;
          }
        } else {
          i = skipTo('>', lt + 2); // <!doctype>, <![CDATA[ … > and other bogus comments
        }
        textStart = i;
        continue;
      }
      if (c === '?') {
        flushText(lt);
        i = skipTo('>', lt + 2);
        textStart = i;
        continue;
      }
      if (c === '/') {
        const d = s.charAt(lt + 2);
        if (/[A-Za-z]/.test(d)) {
          flushText(lt);
          let j = lt + 2;
          while (j < n && !WS.test(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
          const name = s.slice(lt + 2, j).toLowerCase();
          const close = s.indexOf('>', j);
          if (close < 0) { i = n; textStart = n; break; }
          emit({ type: 'end', name });
          i = close + 1;
          textStart = i;
          continue;
        }
        if (d === '>') { flushText(lt); i = lt + 3; textStart = i; continue; }
        if (d === '') { i = n; break; } // '</' at the end of input is text
        flushText(lt);
        i = skipTo('>', lt + 2);
        textStart = i;
        continue;
      }
      if (!/[A-Za-z]/.test(c)) { i = lt + 1; continue; } // a lone '<' is text

      // Start tag.
      let j = lt + 1;
      while (j < n && !WS.test(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
      const name = s.slice(lt + 1, j).toLowerCase();
      const attrs = new Map();
      let selfClosing = false;
      let done = false;
      while (j < n) {
        while (j < n && WS.test(s[j])) j++;
        if (j >= n) break;
        const ch = s[j];
        if (ch === '>') { j++; done = true; break; }
        if (ch === '/') {
          if (s[j + 1] === '>') { selfClosing = true; j += 2; done = true; break; }
          j++;
          continue;
        }
        const nameStart = j;
        j++;
        while (j < n && !WS.test(s[j]) && s[j] !== '/' && s[j] !== '>' && s[j] !== '=') j++;
        const attrName = s.slice(nameStart, j).toLowerCase();
        let k = j;
        while (k < n && WS.test(s[k])) k++;
        let value = '';
        if (s[k] === '=') {
          k++;
          while (k < n && WS.test(s[k])) k++;
          const q = s[k];
          if (q === '"' || q === "'") {
            const end = s.indexOf(q, k + 1);
            if (end < 0) { j = n; break; }
            value = s.slice(k + 1, end);
            j = end + 1;
          } else {
            const vs = k;
            while (k < n && !WS.test(s[k]) && s[k] !== '>') k++;
            value = s.slice(vs, k);
            j = k;
          }
        }
        if (!attrs.has(attrName)) attrs.set(attrName, decodeEntities(value, true));
      }
      if (!done) { flushText(lt); i = n; textStart = n; break; } // tag cut off by end of input
      flushText(lt);
      emit({ type: 'start', name, attrs, selfClosing });
      i = j;
      textStart = i;

      if (name === 'plaintext') {
        if (n > i) emit({ type: 'text', text: s.slice(i) });
        i = n; textStart = n;
        break;
      }
      if (RAW_TEXT.has(name) || RCDATA.has(name)) {
        const re = new RegExp('</' + name + '[\\t\\n\\f\\r />]', 'ig');
        re.lastIndex = i;
        const m = re.exec(s);
        const end = m ? m.index : n;
        if (end > i) {
          const raw = s.slice(i, end);
          emit({ type: 'text', text: RCDATA.has(name) ? decodeEntities(raw, false) : raw });
        }
        i = end;
        textStart = i;
      }
    }
    flushText(n);
  }

  function attachmentIds(rawBody) {
    const ids = [];
    if (!rawBody) return ids;
    let m;
    ATTACHMENT.lastIndex = 0;
    while ((m = ATTACHMENT.exec(String(rawBody)))) {
      const id = m[1].toLowerCase();
      if (ids.indexOf(id) < 0) ids.push(id);
    }
    return ids;
  }

  // Parses a URL the way a browser reads the attribute. With absolute set,
  // relative and protocol-relative values are rejected instead of resolved.
  function cleanUrl(raw, absolute) {
    if (raw == null) return null;
    const v = String(raw).replace(/[\t\n\r]/g, '').replace(/^[\u0000- \u007f-\u009f]+|[\u0000- \u007f-\u009f]+$/g, '');
    if (!v) return null;
    try { return absolute ? new URL(v) : new URL(v, BASE); } catch (e) { return null; }
  }

  function filterClass(value) {
    if (!value) return '';
    const kept = [];
    for (const token of String(value).split(/[\t\n\f\r ]+/)) {
      if (token && CLASS_OK.test(token) && kept.indexOf(token) < 0) kept.push(token);
    }
    return kept.join(' ');
  }

  function sanitizeHtml(html, ctx) {
    ctx = ctx || {};
    const org = String(ctx.org || 'draykerdk').toLowerCase();
    const threadExists = typeof ctx.threadExists === 'function' ? ctx.threadExists : null;
    const rawIds = attachmentIds(ctx.rawBody);
    const privateIds = new Map();
    let nextRaw = 0;

    // Expiring private-user-images URLs carry the attachment id in their path;
    // fall back to the ids in the raw markdown in order of appearance.
    const privateToStable = (url) => {
      const key = url.pathname;
      if (!privateIds.has(key)) {
        const m = url.pathname.match(UUID);
        let id = m ? m[0].toLowerCase() : null;
        if (!id && nextRaw < rawIds.length) id = rawIds[nextRaw++];
        privateIds.set(key, id);
      }
      const id = privateIds.get(key);
      return id ? new URL('https://github.com/user-attachments/assets/' + id) : null;
    };

    const safeHref = (raw) => {
      let url = cleanUrl(raw);
      if (!url) return null;
      if (url.hostname === 'private-user-images.githubusercontent.com') url = privateToStable(url);
      if (!url) return null;
      if (url.protocol === 'mailto:') return url.href;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (threadExists && url.protocol === 'https:' && url.hostname === 'github.com' && !url.search) {
        const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/?$/);
        if (m && m[1].toLowerCase() === org) {
          const slug = threadExists(decodeURIComponent(m[2]), Number(m[3]));
          if (slug) return '/t/' + encodeURIComponent(slug) + '/' + Number(m[3]) + '/' + url.hash;
        }
      }
      return url.href;
    };

    const safeSrc = (raw) => {
      let url = cleanUrl(raw, true);
      if (!url) return null;
      if (url.hostname === 'private-user-images.githubusercontent.com') url = privateToStable(url);
      if (!url || url.protocol !== 'https:') return null;
      return url.href;
    };

    // Returns the attribute string for an allowed element, or null to drop the element.
    const attributesFor = (name, attrs) => {
      const parts = [];
      const add = (key, value) => parts.push(value === true ? key : key + '="' + escapeAttr(stripNulls(String(value))) + '"');
      if (name === 'a') {
        const href = attrs.has('href') ? safeHref(attrs.get('href')) : null;
        if (href) add('href', href);
      } else if (name === 'img') {
        const src = safeSrc(attrs.get('src'));
        if (!src) return null;
        add('src', src);
        if (attrs.has('alt')) add('alt', attrs.get('alt'));
        if (attrs.has('title')) add('title', attrs.get('title'));
        for (const key of ['width', 'height']) {
          const v = String(attrs.get(key) || '').trim();
          if (/^[0-9]{1,5}%?$/.test(v)) add(key, v);
        }
      } else if (name === 'th' || name === 'td') {
        const align = String(attrs.get('align') || '').trim().toLowerCase();
        if (align === 'left' || align === 'right' || align === 'center' || align === 'justify') add('align', align);
      } else if (name === 'ol') {
        const start = String(attrs.get('start') || '').trim();
        if (/^-?[0-9]{1,9}$/.test(start)) add('start', String(Number(start)));
      } else if (name === 'input') {
        if (String(attrs.get('type') || '').trim().toLowerCase() !== 'checkbox') return null;
        add('type', 'checkbox');
        if (attrs.has('checked')) add('checked', true);
        add('disabled', true);
      } else if (name === 'details') {
        if (attrs.has('open')) add('open', true);
      }
      const cls = filterClass(attrs.get('class'));
      if (cls) add('class', cls);
      if (name === 'a') add('rel', 'nofollow ugc noopener noreferrer');
      if (name === 'img') { add('loading', 'lazy'); add('decoding', 'async'); add('referrerpolicy', 'no-referrer'); }
      return parts.length ? ' ' + parts.join(' ') : '';
    };

    const out = [];
    const stack = []; // { name, out: emitted tag name | null, drop: bool }
    let dropDepth = 0;
    let depth = 0;

    const popTo = (index) => {
      while (stack.length > index) {
        const entry = stack.pop();
        if (entry.out) { out.push('</' + entry.out + '>'); depth--; }
        if (entry.drop) dropDepth--;
      }
    };
    const findOpen = (test, boundary) => {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (test(stack[k].name)) return k;
        if (boundary && boundary.has(stack[k].name)) return -1;
      }
      return -1;
    };
    const LI_SCOPE = words('ul ol table blockquote details td th');
    const CELL_SCOPE = words('tr table');
    const ROW_SCOPE = words('table');

    const impliedEnds = (name) => {
      let k = -1;
      if (name === 'li') k = findOpen((x) => x === 'li', LI_SCOPE);
      else if (name === 'td' || name === 'th') k = findOpen((x) => x === 'td' || x === 'th', CELL_SCOPE);
      else if (name === 'tr') k = findOpen((x) => x === 'tr', ROW_SCOPE);
      else if (name === 'thead' || name === 'tbody') k = findOpen((x) => x === 'thead' || x === 'tbody', ROW_SCOPE);
      if (k >= 0) popTo(k);
      if ((name === 'p' || BLOCK.has(name)) && stack.length && stack[stack.length - 1].name === 'p') popTo(stack.length - 1);
    };

    tokenize(html, (tok) => {
      if (tok.type === 'text') {
        if (dropDepth === 0) out.push(escapeText(stripNulls(tok.text)));
        return;
      }
      const name = tok.name;
      if (tok.type === 'end') {
        const k = HEADING.test(name) ? findOpen((x) => HEADING.test(x)) : findOpen((x) => x === name);
        if (k >= 0) popTo(k);
        return;
      }
      if (dropDepth > 0) {
        if (!VOID.has(name) && !tok.selfClosing) stack.push({ name, out: null, drop: false });
        return;
      }
      if (DROP_CONTENT.has(name)) {
        if (!VOID.has(name)) { stack.push({ name, out: null, drop: true }); dropDepth++; }
        return;
      }
      const target = Object.prototype.hasOwnProperty.call(ALLOWED, name) ? ALLOWED[name] : null;
      if (!target) {
        if (!VOID.has(name)) stack.push({ name, out: null, drop: false });
        return;
      }
      impliedEnds(name);
      const attrs = attributesFor(name, tok.attrs);
      if (attrs === null) return;
      if (depth >= MAX_DEPTH) {
        if (!VOID.has(name)) stack.push({ name, out: null, drop: false });
        return;
      }
      out.push('<' + target + attrs + '>');
      if (!VOID.has(name)) { stack.push({ name, out: target, drop: false }); depth++; }
    });
    popTo(0);
    return out.join('');
  }

  function htmlToText(html) {
    const out = [];
    let dropDepth = 0;
    const stack = [];
    tokenize(html, (tok) => {
      if (tok.type === 'text') {
        if (dropDepth === 0) out.push(tok.text);
        return;
      }
      const name = tok.name;
      if (tok.type === 'end') {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k] === name) {
            while (stack.length > k) if (DROP_CONTENT.has(stack.pop())) dropDepth--;
            break;
          }
        }
        if (dropDepth === 0 && TEXT_BREAK.has(name)) out.push('\n');
        return;
      }
      if (DROP_CONTENT.has(name)) {
        if (!VOID.has(name)) { stack.push(name); dropDepth++; }
        return;
      }
      if (!VOID.has(name) && !(dropDepth > 0 && tok.selfClosing)) stack.push(name);
      if (dropDepth > 0) return;
      if (TEXT_BREAK.has(name)) out.push('\n');
      else if (TEXT_SPACE.has(name)) out.push(' ');
    });
    return out.join('').replace(/\u0000/g, '').replace(/[\s ]+/g, ' ').trim();
  }

  const api = { sanitizeHtml, htmlToText, decodeEntities, tokenize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ForumSanitize = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
