// A fast, dependency-free reimplementation of makefun-site 1.0.0's build.
// Written from the vendor README (the spec) plus black-box probes of the
// reference's behaviour on crafted inputs. run(input) returns the output
// tree for one site: every built page's index.html, the index and tag pages,
// build-report.txt and every static file, byte for byte identical to the
// reference. No dependencies, no network, no clock, no randomness.
//
// Speed comes from: templates compiled once into node trees; Markdown
// rendered in a single line pass with one inline scanner; slugs cached;
// strings built with array joins; no per-line regex passes over bodies.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_ESC_RE = /[&<>"']/g;
const HTML_ESC_TEST = /[&<>"']/;

function escapeHtml(s) {
  if (!HTML_ESC_TEST.test(s)) return s;
  return s.replace(HTML_ESC_RE, (ch) => HTML_ESC[ch]);
}

function trimSpacesTabs(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isSpaceCode(cp) {
  return (cp >= 9 && cp <= 13) || cp === 32 || cp === 0x00a0 || cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f ||
    cp === 0x205f || cp === 0x3000 || cp === 0xfeff;
}

// ---------------------------------------------------------------- slugs

const slugCache = new Map();

function slugOf(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let v = text.normalize('NFKD').replace(/\p{M}/gu, '');
  v = v.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  v = v.replace(/[^a-z0-9]+/g, '-');
  v = v.replace(/^-+/, '').replace(/-+$/, '');
  if (v.length > 64) {
    v = v.slice(0, 64);
    if (v.endsWith('-')) v = v.slice(0, -1);
  }
  if (v === '') v = 'untitled';
  slugCache.set(text, v);
  return v;
}

function uniqueSlug(base, taken) {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  for (;;) {
    const cand = base + '-' + n;
    if (!taken.has(cand)) {
      taken.add(cand);
      return cand;
    }
    n++;
  }
}

function dateLong(dateStr) {
  if (!dateStr) return '';
  const day = parseInt(dateStr.slice(8, 10), 10);
  const month = parseInt(dateStr.slice(5, 7), 10);
  const year = parseInt(dateStr.slice(0, 4), 10);
  return day + ' ' + MONTHS[month - 1] + ' ' + year;
}

// ---------------------------------------------------------------- front matter

const KNOWN_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);

function parseQuoted(value, key) {
  if (value.length < 2 || value[value.length - 1] !== '"') {
    return { error: 'key "' + key + '": a quoted string is not closed' };
  }
  let out = '';
  for (let i = 1; i < value.length - 1; i++) {
    const c = value[i];
    if (c === '"') return { error: 'key "' + key + '": a quoted string holds a stray quote' };
    if (c === '\\') {
      const d = value[i + 1];
      if (d !== '"' && d !== '\\') {
        return { error: 'key "' + key + '": a quoted string holds an escape other than \\" or \\\\' };
      }
      out += d;
      i++;
      continue;
    }
    out += c;
  }
  return { value: out };
}

function parseStringValue(value, key) {
  if (value[0] === '"') return parseQuoted(value, key);
  if (value[0] === '[') return { error: 'key "' + key + '": a bare string opens on [' };
  return { value };
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function parseFrontMatter(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return { ok: false, reason: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { ok: false, reason: 'the front matter is not closed' };
  const fm = {};
  const seen = new Set();
  for (let k = 1; k < close; k++) {
    const line = lines[k];
    const n = k + 1;
    if (isBlank(line)) continue;
    if (line[0] === '#') continue;
    const m = /^([a-z_]+):( (.*))?$/.exec(line);
    if (!m) return { ok: false, reason: 'line ' + n + ' is not "key: value"' };
    const key = m[1];
    const value = (m[3] === undefined ? '' : m[3]).replace(/[ \t]+$/, '');
    if (!KNOWN_KEYS.has(key)) return { ok: false, reason: 'unknown key "' + key + '"' };
    if (seen.has(key)) return { ok: false, reason: 'key "' + key + '" is given twice' };
    seen.add(key);
    if (value === '') return { ok: false, reason: 'key "' + key + '" has no value' };
    if (key === 'title' || key === 'summary') {
      const r = parseStringValue(value, key);
      if (r.error) return { ok: false, reason: r.error };
      fm[key] = r.value;
    } else if (key === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, reason: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      const y = parseInt(value.slice(0, 4), 10);
      const mo = parseInt(value.slice(5, 7), 10);
      const d = parseInt(value.slice(8, 10), 10);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        return { ok: false, reason: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      fm.date = value;
    } else if (key === 'tags') {
      if (value[0] !== '[' || value[value.length - 1] !== ']') {
        return { ok: false, reason: 'key "tags": not a list [a, b]' };
      }
      const inner = value.slice(1, -1);
      const tags = [];
      if (inner !== '') {
        for (const part of inner.split(',')) {
          const t = part.trim();
          if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
            return { ok: false, reason: 'key "tags": an empty tag, or one holding " [ or ]' };
          }
          tags.push(t);
        }
      }
      fm.tags = tags;
    } else if (key === 'draft') {
      if (value === 'true') fm.draft = true;
      else if (value === 'false') fm.draft = false;
      else return { ok: false, reason: 'key "draft": true or false' };
    } else if (key === 'layout') {
      if (!/^[a-z0-9-]+$/.test(value)) {
        return { ok: false, reason: 'key "layout": not a template name' };
      }
      fm.layout = value;
    } else if (key === 'slug') {
      if (value.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) {
        return { ok: false, reason: 'key "slug": not a slug' };
      }
      fm.slug = value;
    }
  }
  if (!seen.has('title')) return { ok: false, reason: 'no title' };
  return { ok: true, fm, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- templates

const PATH_SEG_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parsePath(inner) {
  if (inner === '') return null;
  const parts = inner.split('.');
  for (const p of parts) {
    if (!PATH_SEG_RE.test(p)) return null;
  }
  return parts;
}

function parseTemplate(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const a = src.indexOf('{{', i);
    const b = src.indexOf('{%', i);
    let next = -1;
    let kind = null;
    if (a !== -1 && (b === -1 || a < b)) {
      next = a;
      kind = src.startsWith('{{{', a) ? 'raw' : 'var';
    } else if (b !== -1) {
      next = b;
      kind = 'tag';
    }
    if (next === -1) {
      tokens.push({ k: 'text', s: src.slice(i) });
      break;
    }
    if (next > i) tokens.push({ k: 'text', s: src.slice(i, next) });
    if (kind === 'raw') {
      const e = src.indexOf('}}}', next + 3);
      if (e === -1) return { error: 'a {{{ is not closed' };
      tokens.push({ k: 'raw', inner: src.slice(next + 3, e).trim() });
      i = e + 3;
    } else if (kind === 'var') {
      const e = src.indexOf('}}', next + 2);
      if (e === -1) return { error: 'a {{ is not closed' };
      tokens.push({ k: 'var', inner: src.slice(next + 2, e).trim() });
      i = e + 2;
    } else {
      const e = src.indexOf('%}', next + 2);
      if (e === -1) return { error: 'a {% is not closed' };
      tokens.push({ k: 'tag', inner: src.slice(next + 2, e).trim() });
      i = e + 2;
    }
  }

  // A {% %} tag alone on its line (only spaces or tabs beside it) takes the
  // whole line with it, its newline included.
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.k !== 'tag') continue;
    const prev = tokens[t - 1];
    const nextTok = tokens[t + 1];
    let okPrev = false;
    let okNext = false;
    if (!prev) okPrev = true;
    else if (prev.k === 'text') {
      const idx = prev.s.lastIndexOf('\n');
      const tail = idx === -1 ? prev.s : prev.s.slice(idx + 1);
      if (/^[ \t]*$/.test(tail)) okPrev = true;
    }
    if (!nextTok) okNext = true;
    else if (nextTok.k === 'text') {
      if (/^[ \t]*\n/.test(nextTok.s)) okNext = true;
      else if (/^[ \t]*$/.test(nextTok.s)) okNext = true;
    }
    if (okPrev && okNext) {
      if (prev && prev.k === 'text') {
        const idx = prev.s.lastIndexOf('\n');
        prev.s = idx === -1 ? '' : prev.s.slice(0, idx + 1);
      }
      if (nextTok && nextTok.k === 'text') {
        const m = /^[ \t]*\n/.exec(nextTok.s);
        if (m) nextTok.s = nextTok.s.slice(m[0].length);
        else if (/^[ \t]*$/.test(nextTok.s)) nextTok.s = '';
      }
    }
  }

  const root = [];
  const stack = [{ kind: 'root', body: root }];
  for (const tok of tokens) {
    const top = stack[stack.length - 1];
    if (tok.k === 'text') {
      if (tok.s !== '') top.body.push({ k: 'text', s: tok.s });
      continue;
    }
    if (tok.k === 'var' || tok.k === 'raw') {
      const segs = parsePath(tok.inner);
      if (!segs) return { error: '"' + tok.inner + '" is not a path' };
      top.body.push({ k: tok.k, segs });
      continue;
    }
    const inner = tok.inner;
    if (inner === 'endfor') {
      if (top.kind !== 'for') return { error: 'an endfor with no open for' };
      stack.pop();
      continue;
    }
    if (inner === 'endif') {
      if (top.kind !== 'if') return { error: 'an endif with no open if' };
      stack.pop();
      continue;
    }
    if (inner === 'else') {
      if (top.kind !== 'if' || top.node.else) return { error: 'an else outside an if' };
      top.node.else = [];
      top.body = top.node.else;
      continue;
    }
    let m;
    if ((m = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/.exec(inner))) {
      const segs = parsePath(m[2]);
      if (!segs) return { error: '{% ' + inner + ' %} is not a tag' };
      const node = { k: 'for', name: m[1], segs, body: [] };
      top.body.push(node);
      stack.push({ kind: 'for', node, body: node.body });
      continue;
    }
    if ((m = /^if\s+(not\s+)?(.+)$/.exec(inner))) {
      const segs = parsePath(m[2]);
      if (!segs) return { error: '{% ' + inner + ' %} is not a tag' };
      const node = { k: 'if', segs, neg: !!m[1], then: [], else: null };
      top.body.push(node);
      stack.push({ kind: 'if', node, body: node.then });
      continue;
    }
    if ((m = /^include\s+"([^"]*)"$/.exec(inner))) {
      top.body.push({ k: 'include', name: m[1] });
      continue;
    }
    return { error: '{% ' + inner + ' %} is not a tag' };
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    return { error: top.kind === 'for' ? 'a for is not closed' : 'a if is not closed' };
  }
  return { nodes: root };
}

function resolvePath(segs, root, frames) {
  let v;
  let found = false;
  const first = segs[0];
  if (first === 'loop') {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].loop) {
        v = frames[i].loop;
        found = true;
        break;
      }
    }
  } else {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].name === first) {
        v = frames[i].value;
        found = true;
        break;
      }
    }
    if (!found && Object.prototype.hasOwnProperty.call(root, first)) {
      v = root[first];
      found = true;
    }
  }
  if (!found) return undefined;
  for (let s = 1; s < segs.length; s++) {
    if (v === null || v === undefined) return undefined;
    const t = typeof v;
    if ((t === 'object' || t === 'function' || t === 'string') &&
      Object.prototype.hasOwnProperty.call(v, segs[s])) {
      v = v[segs[s]];
    } else {
      return undefined;
    }
  }
  return v;
}

function truthy(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function writeValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += writeValue(v[i]);
    }
    return out;
  }
  return '';
}

function renderNodes(nodes, root, frames, out, depth, compiled) {
  for (const node of nodes) {
    if (node.k === 'text') {
      out.push(node.s);
    } else if (node.k === 'var') {
      out.push(escapeHtml(writeValue(resolvePath(node.segs, root, frames))));
    } else if (node.k === 'raw') {
      out.push(writeValue(resolvePath(node.segs, root, frames)));
    } else if (node.k === 'for') {
      const arr = resolvePath(node.segs, root, frames);
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
          frames.push({
            name: node.name,
            value: arr[i],
            loop: { index: i + 1, first: i === 0, last: i === arr.length - 1, length: arr.length },
          });
          renderNodes(node.body, root, frames, out, depth, compiled);
          frames.pop();
        }
      }
    } else if (node.k === 'if') {
      let cond = truthy(resolvePath(node.segs, root, frames));
      if (node.neg) cond = !cond;
      if (cond) renderNodes(node.then, root, frames, out, depth, compiled);
      else if (node.else) renderNodes(node.else, root, frames, out, depth, compiled);
    } else if (node.k === 'include') {
      if (depth < 8) {
        const child = compiled.get(node.name);
        if (child) renderNodes(child, root, frames, out, depth + 1, compiled);
      }
    }
  }
}

function renderTemplate(nodes, root, compiled) {
  const out = [];
  renderNodes(nodes, root, [], out, 0, compiled);
  return out.join('');
}

// ---------------------------------------------------------------- Markdown

function resolveLink(target, ctx) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') {
    return target;
  }
  const hash = target.indexOf('#');
  const pathPart = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const parts = ctx.dir === '' ? [] : ctx.dir.split('/');
  for (const seg of pathPart.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const resolved = parts.join('/');
  const pageUrl = ctx.pageUrls.get(resolved);
  if (pageUrl !== undefined) return pageUrl + frag;
  if (ctx.staticPaths.has(resolved)) return ctx.base + '/' + resolved + frag;
  const key = ctx.src + '\n' + target;
  if (!ctx.brokenKeys.has(key)) {
    ctx.brokenKeys.add(key);
    ctx.broken.push(target);
  }
  return target;
}

function findStrongClose(text, start) {
  let j = start;
  while (j < text.length - 1) {
    const c = text[j];
    if (c === '\\' && j + 1 < text.length && ESCAPABLE.has(text[j + 1])) {
      j += 2;
      continue;
    }
    if (c === '*' && text[j + 1] === '*') return j;
    j++;
  }
  return -1;
}

function findEmClose(text, start) {
  let j = start;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\' && j + 1 < text.length && ESCAPABLE.has(text[j + 1])) {
      j += 2;
      continue;
    }
    if (c === '*' && text[j + 1] === '*') {
      j += 2;
      continue;
    }
    if (c === '*' && j > start) return j;
    j++;
  }
  return -1;
}

function parseLink(text, i, ctx) {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\' && j + 1 < text.length && ESCAPABLE.has(text[j + 1])) {
      j += 2;
      continue;
    }
    if (c === ']') break;
    j++;
  }
  if (j >= text.length || text[j] !== ']' || text[j + 1] !== '(') return null;
  const k = text.indexOf(')', j + 2);
  if (k === -1) return null;
  const target = text.slice(j + 2, k);
  if (target === '' || /[\s]/.test(target)) return null;
  const inner = renderInline(text.slice(i + 1, j), ctx);
  const href = resolveLink(target, ctx);
  return { html: '<a href="' + escapeHtml(href) + '">' + inner + '</a>', next: k + 1 };
}

function renderInline(text, ctx) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(text[i + 1])) {
        out.push(escapeHtml(text[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = text.indexOf('`', i + 1);
      if (j === i + 1) {
        out.push('`');
        i++;
      } else if (j !== -1) {
        out.push('<code>' + escapeHtml(text.slice(i + 1, j)) + '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*' && text[i + 1] === '*') {
      const j = findStrongClose(text, i + 2);
      if (j !== -1 && j !== i + 2) {
        out.push('<strong>' + renderInline(text.slice(i + 2, j), ctx) + '</strong>');
        i = j + 2;
      } else {
        out.push('**');
        i += 2;
      }
      continue;
    }
    if (c === '*') {
      const j = findEmClose(text, i + 1);
      if (j !== -1) {
        out.push('<em>' + renderInline(text.slice(i + 1, j), ctx) + '</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const link = parseLink(text, i, ctx);
      if (link) {
        out.push(link.html);
        i = link.next;
      } else {
        out.push('[');
        i++;
      }
      continue;
    }
    let j = n;
    const kb = text.indexOf('\\', i);
    if (kb !== -1 && kb < j) j = kb;
    const kq = text.indexOf('`', i);
    if (kq !== -1 && kq < j) j = kq;
    const ks = text.indexOf('*', i);
    if (ks !== -1 && ks < j) j = ks;
    const kl = text.indexOf('[', i);
    if (kl !== -1 && kl < j) j = kl;
    out.push(escapeHtml(text.slice(i, j)));
    i = j;
  }
  return out.join('');
}

function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const langOk = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!langOk) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingInfo(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n < 1 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  const text = trimSpacesTabs(line.slice(n + 1));
  if (text === '') return null;
  return { level: n, text };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function listInfo(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, text: trimSpacesTabs(line.slice(2)) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    let num = 0;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c < 48 || c > 57) break;
      num = num * 10 + (c - 48);
      i++;
    }
    if (line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, num, text: trimSpacesTabs(line.slice(i + 2)) };
    }
  }
  return null;
}

function isListContinuation(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2) return false;
  if (i >= line.length) return false;
  const c = line.charCodeAt(i);
  return c !== 32 && c !== 9;
}

function renderMarkdown(body, ctx) {
  const lines = body.split('\n');
  const out = [];
  const toc = [];
  let excerpt = '';
  let excerptDone = false;
  const headingTaken = new Set();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      const buf = [];
      while (i < lines.length && !isFenceClose(lines[i])) {
        buf.push(escapeHtml(lines[i]) + '\n');
        i++;
      }
      if (i < lines.length) i++;
      out.push('<pre><code' + (lang !== '' ? ' class="language-' + lang + '"' : '') + '>' +
        buf.join('') + '</code></pre>\n');
      continue;
    }
    const heading = headingInfo(line);
    if (heading) {
      const id = uniqueSlug(slugOf(heading.text), headingTaken);
      const html = renderInline(heading.text, ctx);
      if (heading.level === 2 || heading.level === 3) toc.push({ level: heading.level, id, html });
      out.push('<h' + heading.level + ' id="' + id + '">' + html + '</h' + heading.level + '>\n');
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const parts = [];
      while (i < lines.length && lines[i][0] === '>') {
        let s = lines[i].slice(1);
        if (s[0] === ' ') s = s.slice(1);
        s = trimSpacesTabs(s);
        if (s !== '') parts.push(s);
        i++;
      }
      out.push('<blockquote>\n');
      if (parts.length > 0) out.push('<p>' + renderInline(parts.join('\n'), ctx) + '</p>\n');
      out.push('</blockquote>\n');
      continue;
    }
    const list = listInfo(line);
    if (list) {
      const ordered = list.ordered;
      const firstNum = list.num;
      const items = [];
      let cur = list.text;
      i++;
      while (i < lines.length) {
        const l2 = lines[i];
        const li = listInfo(l2);
        if (li && li.ordered === ordered) {
          items.push(cur);
          cur = li.text;
          i++;
          continue;
        }
        if (isListContinuation(l2)) {
          cur += '\n' + trimSpacesTabs(l2);
          i++;
          continue;
        }
        break;
      }
      items.push(cur);
      out.push(ordered ? '<ol' + (firstNum !== 1 ? ' start="' + firstNum + '"' : '') + '>\n' : '<ul>\n');
      for (const it of items) out.push('<li>' + renderInline(it, ctx) + '</li>\n');
      out.push(ordered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const plines = [];
    while (i < lines.length) {
      const l2 = lines[i];
      if (isBlank(l2)) break;
      if (fenceOpen(l2) !== null) break;
      if (headingInfo(l2)) break;
      if (isHr(l2)) break;
      plines.push(trimSpacesTabs(l2));
      i++;
    }
    const inner = renderInline(plines.join('\n'), ctx);
    if (!excerptDone) {
      excerpt = inner;
      excerptDone = true;
    }
    out.push('<p>' + inner + '</p>\n');
  }
  let words = 0;
  let inWord = false;
  for (let wi = 0; wi < body.length; wi++) {
    if (isSpaceCode(body.charCodeAt(wi))) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  const readingMinutes = Math.max(1, Math.ceil(words / 200));
  return { html: out.join(''), toc, excerpt, readingMinutes };
}

// ---------------------------------------------------------------- build

function dirOf(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function run(input) {
  const site = input.site;
  let base = site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);

  const report = [];
  const compiled = new Map();
  const templateNames = Object.keys(input.templates).sort();
  for (const name of templateNames) {
    const parsed = parseTemplate(input.templates[name]);
    if (parsed.error) report.push('template "' + name + '": ' + parsed.error);
    else compiled.set(name, parsed.nodes);
  }

  const sortedFiles = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const pages = [];
  const statics = [];
  for (const f of sortedFiles) {
    if (f.path.endsWith('.md')) {
      const content = f.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const parsed = parseFrontMatter(content);
      if (!parsed.ok) {
        report.push('refused ' + f.path + ': ' + parsed.reason);
        continue;
      }
      const fm = parsed.fm;
      const isPost = f.path.startsWith('posts/');
      if (f.path.startsWith('tags/')) {
        report.push('refused ' + f.path + ": tags/ is the generator's own");
        continue;
      }
      if (f.path.startsWith('page/')) {
        report.push('refused ' + f.path + ": page/ is the generator's own");
        continue;
      }
      if (isPost && fm.date === undefined) {
        report.push('refused ' + f.path + ': a post needs a date');
        continue;
      }
      const layout = fm.layout || (isPost ? 'post' : 'page');
      if (!compiled.has(layout)) {
        report.push('refused ' + f.path + ': layout "' + layout + '" is no template that parses');
        continue;
      }
      if (fm.draft === true) {
        report.push('draft ' + f.path);
        continue;
      }
      pages.push({ path: f.path, fm, body: parsed.body, isPost, dir: isPost ? 'posts' : dirOf(f.path), layout });
    } else {
      statics.push(f);
    }
  }

  const takenByDir = new Map();
  for (const p of pages) {
    let taken = takenByDir.get(p.dir);
    if (!taken) {
      taken = new Set();
      if (p.dir === '') {
        taken.add('posts');
        taken.add('tags');
        taken.add('page');
      }
      takenByDir.set(p.dir, taken);
    }
    const baseSlug = p.fm.slug || slugOf(p.fm.title);
    p.slug = uniqueSlug(baseSlug, taken);
    p.url = base + '/' + (p.dir !== '' ? p.dir + '/' : '') + p.slug + '/';
    p.outPath = (p.dir !== '' ? p.dir + '/' : '') + p.slug + '/index.html';
    const rawTags = p.fm.tags || [];
    p.tagList = [];
    const seenTag = new Set();
    for (const name of rawTags) {
      const s = slugOf(name);
      if (seenTag.has(s)) continue;
      seenTag.add(s);
      p.tagList.push({ name, slug: s });
    }
  }

  const posts = pages.filter((p) => p.isPost);
  posts.sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  const tagMap = new Map();
  for (const post of posts) {
    for (const t of post.tagList) {
      let tag = tagMap.get(t.slug);
      if (!tag) {
        tag = { name: t.name, slug: t.slug, posts: [] };
        tagMap.set(t.slug, tag);
      }
      tag.posts.push(post);
    }
  }
  const tags = [...tagMap.values()].sort((a, b) => {
    if (a.posts.length !== b.posts.length) return b.posts.length - a.posts.length;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const tagBySlug = new Map(tags.map((t) => [t.slug, t]));
  const tagList = tags.map((t) => ({
    name: t.name,
    slug: t.slug,
    url: base + '/tags/' + t.slug + '/',
    count: t.posts.length,
  }));
  const tagUrlOf = (slug) => {
    const t = tagBySlug.get(slug);
    return t ? base + '/tags/' + slug + '/' : '';
  };

  const pageUrls = new Map(pages.map((p) => [p.path, p.url]));
  const staticPaths = new Set(statics.map((s) => s.path));

  for (const p of pages) {
    const ctx = {
      dir: dirOf(p.path),
      src: p.path,
      base,
      pageUrls,
      staticPaths,
      broken: [],
      brokenKeys: new Set(),
    };
    const md = renderMarkdown(p.body, ctx);
    p.html = md.html;
    p.toc = md.toc;
    p.excerpt = md.excerpt;
    p.readingMinutes = md.readingMinutes;
    for (const target of ctx.broken) report.push('broken-link ' + p.path + ' -> ' + target);
  }

  const cardOf = (p) => ({
    title: p.fm.title,
    url: p.url,
    date: p.fm.date || '',
    date_long: dateLong(p.fm.date || ''),
    summary: p.fm.summary || '',
    excerpt: p.excerpt,
    reading_minutes: p.readingMinutes,
    tags: p.tagList.map((t) => {
      const g = tagBySlug.get(t.slug);
      return { name: g ? g.name : t.name, slug: t.slug, url: tagUrlOf(t.slug) };
    }),
  });
  const postCards = posts.map(cardOf);
  const recent = postCards.slice(0, site.recent);
  const siteObj = { title: site.title, base_url: base };

  const out = {};
  const postIndex = new Map(posts.map((p, i) => [p, i]));
  for (const p of pages) {
    let newer = null;
    let older = null;
    if (p.isPost) {
      const i = postIndex.get(p);
      if (i > 0) {
        const q = posts[i - 1];
        newer = { title: q.fm.title, url: q.url, date: q.fm.date, date_long: dateLong(q.fm.date) };
      }
      if (i < posts.length - 1) {
        const q = posts[i + 1];
        older = { title: q.fm.title, url: q.url, date: q.fm.date, date_long: dateLong(q.fm.date) };
      }
    }
    const pageObj = cardOf(p);
    pageObj.slug = p.slug;
    pageObj.content = p.html;
    pageObj.toc = p.toc;
    pageObj.newer = newer;
    pageObj.older = older;
    pageObj.is_post = p.isPost;
    const root = { site: siteObj, tags: tagList, recent, page: pageObj };
    out[p.outPath] = renderTemplate(compiled.get(p.layout), root, compiled);
  }

  if (compiled.has('index')) {
    const perPage = site.per_page;
    const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
    for (let n = 1; n <= totalPages; n++) {
      const slice = postCards.slice((n - 1) * perPage, n * perPage);
      const pager = {
        number: n,
        total: totalPages,
        url: n === 1 ? base + '/' : base + '/page/' + n + '/',
        newer_url: n === 1 ? '' : n === 2 ? base + '/' : base + '/page/' + (n - 1) + '/',
        older_url: n < totalPages ? base + '/page/' + (n + 1) + '/' : '',
      };
      const root = { site: siteObj, tags: tagList, recent, posts: slice, pager };
      out[n === 1 ? 'index.html' : 'page/' + n + '/index.html'] = renderTemplate(compiled.get('index'), root, compiled);
    }
  }

  if (compiled.has('tag')) {
    for (const t of tags) {
      const root = {
        site: siteObj,
        tags: tagList,
        recent,
        tag: {
          name: t.name,
          slug: t.slug,
          url: base + '/tags/' + t.slug + '/',
          count: t.posts.length,
          posts: t.posts.map(cardOf),
        },
      };
      out['tags/' + t.slug + '/index.html'] = renderTemplate(compiled.get('tag'), root, compiled);
    }
  }
  if (compiled.has('tags')) {
    out['tags/index.html'] = renderTemplate(compiled.get('tags'), { site: siteObj, tags: tagList, recent }, compiled);
  }

  for (const s of statics) {
    if (Object.prototype.hasOwnProperty.call(out, s.path)) {
      report.push('shadowed ' + s.path + ': a built page has its path');
    } else {
      out[s.path] = s.content;
    }
  }

  report.sort();
  report.push(
    'built ' + (pages.length - posts.length) + ' pages, ' + posts.length + ' posts, ' +
    tags.length + ' tags and ' + statics.length + ' static files',
  );
  out['build-report.txt'] = report.join('\n') + '\n';
  return out;
}
