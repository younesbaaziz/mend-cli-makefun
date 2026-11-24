// main.ts — mend CLI (MIT). Node 22, standard library only.

import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

/** Tracks original and current file states. */
class Tree {
  readonly orig: Map<string, string | null> = new Map();
  readonly now: Map<string, string | null> = new Map();
  readonly renames: Array<[string, string]> = [];

  /** Read a file from the filesystem into orig/now on first access. */
  get(p: string): string | null {
    if (!this.now.has(p)) {
      let content: string | null = null;
      try { content = readFileSync(p, 'utf8'); } catch { content = null; }
      this.orig.set(p, content);
      this.now.set(p, content);
    }
    return this.now.get(p)!;
  }

  original(p: string): string | null {
    if (!this.orig.has(p)) this.get(p);
    return this.orig.get(p)!;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** Split patch text into patch lines (split at \n, strip trailing \r, no trailing empty piece). */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Detect line break and whether the file ends with a line break. */
function fileLineInfo(text: string): { br: string; finalBreak: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  return { br, finalBreak };
}

/** Split a file into lines using its own line break convention. */
function splitFile(text: string): string[] {
  if (text === '') return [];
  const { br, finalBreak } = fileLineInfo(text);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return lines;
}

/** Join lines back with the given break and optional trailing break. */
function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/** Three-tier line matching. Returns all 0-based positions where oldLines match fileLines at this tier. */
function matchLines(oldLines: string[], fileLines: string[], tier: number): number[] {
  const occurrences: number[] = [];
  if (oldLines.length === 0 || oldLines.length > fileLines.length) return occurrences;
  const norm = (s: string): string => {
    if (tier === 0) return s;
    if (tier === 1) return s.replace(/[ \t]+$/, '');
    return s.replace(/^[ \t]+|[ \t]+$/g, '');
  };
  const normedOld = oldLines.map(norm);
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normedOld[j] !== norm(fileLines[i + j])) { match = false; break; }
    }
    if (match) occurrences.push(i);
  }
  return occurrences;
}

/** Find first occurrence of oldLines in fileLines across tiers 0,1,2 (or just 0 if strict).
 *  Returns [tier, position] or [-1, -1]. */
function findMatch(oldLines: string[], fileLines: string[], strict: boolean): [number, number] {
  for (let t = 0; t <= (strict ? 0 : 2); t++) {
    const occ = matchLines(oldLines, fileLines, t);
    if (occ.length > 0) return [t, occ[0]];
  }
  return [-1, -1];
}

/** Find occurrence nearest to target position across tiers. Returns [tier, position] or [-1,-1]. */
function findNearest(oldLines: string[], fileLines: string[], target: number, strict: boolean): [number, number] {
  for (let t = 0; t <= (strict ? 0 : 2); t++) {
    const occ = matchLines(oldLines, fileLines, t);
    if (occ.length === 0) continue;
    // pick nearest to target, ties go to earlier
    let best = occ[0];
    let bestDist = Math.abs(occ[0] - target);
    for (let i = 1; i < occ.length; i++) {
      const d = Math.abs(occ[i] - target);
      if (d < bestDist) { best = occ[i]; bestDist = d; }
    }
    return [t, best];
  }
  return [-1, -1];
}

/** Re-indent N lines for tier-2 matches. F = leading ws of file's first matched line, P = leading ws of old's first line. */
function reindent(newLines: string[], fileFirstLine: string, oldFirstLine: string): string[] {
  const P = (oldFirstLine.match(/^[ \t]*/)?.[0]) ?? '';
  const F = (fileFirstLine.match(/^[ \t]*/)?.[0]) ?? '';
  if (P === F) return newLines;
  return newLines.map((l) => {
    if (l === '' || l.trim() === '') return l;
    if (l.startsWith(P)) return F + l.slice(P.length);
    return l;
  });
}

/** Apply N replacing O in fileLines starting at pos. Context lines from N use file's matched lines.
 *  Returns new lines. tier=2 triggers re-indent of non-context new lines. */
function applyReplacement(
  fileLines: string[],
  pos: number,
  oLines: string[],
  nLines: string[],
  contextMask: boolean[],
  tier: number,
): string[] {
  const fileFirstMatched = fileLines[pos] ?? "";
  const oldFirstLine = oLines[0] ?? "";
  const result: string[] = [];
  const contextCount = contextMask.filter(Boolean).length;
  let seenContext = 0;
  const oIsContext: boolean[] = oLines.map(() => {
    if (seenContext < contextCount) {
      seenContext++;
      return true;
    }
    return false;
  });
  let oIdx = 0;
  for (let i = 0; i < nLines.length; i++) {
    if (contextMask[i]) {
      while (oIdx < oLines.length && !oIsContext[oIdx]) {
        oIdx++;
      }
      const lineFromFile = fileLines[pos + oIdx] ?? oLines[oIdx] ?? nLines[i]!; 
      result.push(lineFromFile);
      oIdx++;
    } else {
      if (tier === 2) {
        result.push(...reindent([nLines[i]!], fileFirstMatched, oldFirstLine));
      } else {
        result.push(nLines[i]!);
      }
    }
  }
  return [...fileLines.slice(0, pos), ...result, ...fileLines.slice(pos + oLines.length)];
}
/** Detect format from patch text. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Validate a path is safe. */
function safe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ─── JSON edits ──────────────────────────────────────────────────────────────

function jsonEdit(v: unknown): ((tree: Tree) => void) | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const requireExists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' &&
      (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = requireExists(tree);
      const { br } = fileLineInfo(before.length > 0 ? before : '\n');
      const crlf = br === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) &&
      typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = requireExists(tree);
      const { br, finalBreak } = fileLineInfo(before.length > 0 ? before : '\n');
      const lines = splitFile(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, br, finalBreak));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): ((tree: Tree) => void)[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: ((tree: Tree) => void)[] = [];

  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (blank(l)) continue;
    let e: ((tree: Tree) => void) | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  }
  return edits;
}

// ─── Unified diff ─────────────────────────────────────────────────────────────

/** Strip leading a/ or b/ from a path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse path from --- or +++ line (after the 4-char prefix). */
function parsePatchPath(rest: string): string {
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  return stripAB(p);
}

interface UnifiedSection {
  oldPath: string | null;   // null = /dev/null
  newPath: string | null;   // null = /dev/null
  isCreate: boolean;
  isDelete: boolean;
  isRename: boolean;
  hunks: UnifiedHunk[];
  lineNo: number; // line number of section start (1-based)
}

interface UnifiedHunk {
  A: number;  // 0-based old start
  C: number;  // 0-based new start
  body: HunkLine[];
  lineNo: number; // 1-based
}

interface HunkLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

function parseUnifiedSections(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let i = 0;

  const consumedDiffGitHeaders = new Set<number>();

  while (i < lines.length) {
    const line = lines[i];

    // Detect section start: diff --git or --- followed by +++
    if (line.startsWith('diff --git ')) {
      // Parse diff --git a/X b/Y
      const m = line.match(/^diff --git (.+?) (.+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);

      const sec: UnifiedSection = {
        oldPath: stripAB(m[1]),
        newPath: stripAB(m[2]),
        isCreate: false,
        isDelete: false,
        isRename: false,
        hunks: [],
        lineNo: i + 1,
      };
      i++;

      // Parse section header lines (before first hunk)
      let renameFrom: string | null = null;
      let renameTo: string | null = null;
      let minusPath: string | null = null;
      let plusPath: string | null = null;
      let expectPlus = false;
      let expectPlusLine = -1;

      while (i < lines.length) {
        const hl = lines[i];
        if (hl.startsWith('@@')) break;
        if (hl.startsWith('diff --git ')) break;

        if (expectPlus) {
          // We saw a --- line and are waiting for +++
          if (!hl.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 1}`);
          plusPath = parsePatchPath(hl.slice(4));
          if (plusPath === '/dev/null') plusPath = null;
          expectPlus = false;
          i++;
          continue;
        }

        if (hl.startsWith('--- ')) {
          consumedDiffGitHeaders.add(i);
          if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) consumedDiffGitHeaders.add(i + 1);
          minusPath = parsePatchPath(hl.slice(4));
          if (minusPath === '/dev/null') minusPath = null;
          expectPlus = true;
          expectPlusLine = i + 2;
          i++;
          continue;
        }
        if (hl.startsWith('+++ ')) {
          // +++ without preceding ---: ignore
          i++;
          continue;
        }
        if (hl.startsWith('rename from ')) {
          renameFrom = hl.slice(12).trim();
          i++;
          continue;
        }
        if (hl.startsWith('rename to ')) {
          renameTo = hl.slice(10).trim();
          i++;
          continue;
        }
        if (hl === 'new file mode' || hl.startsWith('new file mode ')) {
          sec.isCreate = true;
          i++;
          continue;
        }
        if (hl === 'deleted file mode' || hl.startsWith('deleted file mode ')) {
          sec.isDelete = true;
          i++;
          continue;
        }
        // ignore: index, old mode, new mode, similarity index, dissimilarity index, Index:, etc.
        i++;
      }

      if (expectPlus) throw new Exit2(`error: parse ${expectPlusLine}`);

      // Resolve paths
      if (renameFrom !== null && renameTo !== null) {
        sec.oldPath = renameFrom;
        sec.newPath = renameTo;
        sec.isRename = true;
      } else {
        if (minusPath !== null) sec.oldPath = minusPath;
        if (plusPath !== null) sec.newPath = plusPath;
        // /dev/null => null already set
        // If minusPath was /dev/null:
        if (minusPath === null && sec.oldPath !== null && plusPath !== null) {
          sec.isCreate = true;
        }
        if (plusPath === null && sec.newPath !== null && minusPath !== null) {
          sec.isDelete = true;
        }
      }

      // Parse hunks for this section
      while (i < lines.length) {
        const hl = lines[i];
        if (hl.startsWith('diff --git ')) break;
        if (hl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;

        if (hl.startsWith('@@')) {
          const hm = hl.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (!hm) throw new Exit2(`error: parse ${i + 1}`);
          const A = parseInt(hm[1], 10) - 1;
          const C = parseInt(hm[2], 10) - 1;
          const hunk: UnifiedHunk = { A, C, body: [], lineNo: i + 1 };
          i++;

          // Collect body lines
          const rawBody: HunkLine[] = [];
          while (i < lines.length) {
            const bl = lines[i];
            if (bl.startsWith('@@')) break;
            if (bl.startsWith('diff --git ')) break;
            if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
            if (bl === '' || bl.startsWith(' ')) rawBody.push({ kind: ' ', text: bl === '' ? '' : bl.slice(1) });
            else if (bl.startsWith('-')) rawBody.push({ kind: '-', text: bl.slice(1) });
            else if (bl.startsWith('+')) rawBody.push({ kind: '+', text: bl.slice(1) });
            else if (bl.startsWith('\\')) rawBody.push({ kind: '\\', text: bl });
            else break; // non-body line ends hunk
            i++;
          }

          // Strip trailing empty context lines from body
          let end = rawBody.length;
          while (end > 0 && rawBody[end - 1].kind === ' ' && rawBody[end - 1].text === '') end--;
          hunk.body = rawBody.slice(0, end);
          sec.hunks.push(hunk);
          continue;
        }

        // Not a hunk header and not a new section: ignored (prose, fences, etc.)
        i++;
      }
      sections.push(sec);
      continue;
    }

    // --- followed by +++: new section without diff --git (skip if already part of preceding diff --git)
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ') && !consumedDiffGitHeaders.has(i)) {
      const minusRaw = parsePatchPath(line.slice(4));
      const plusRaw = parsePatchPath(lines[i + 1].slice(4));
      const oldPath = minusRaw === '/dev/null' ? null : minusRaw;
      const newPath = plusRaw === '/dev/null' ? null : plusRaw;

      const sec: UnifiedSection = {
        oldPath,
        newPath,
        isCreate: oldPath === null,
        isDelete: newPath === null,
        isRename: oldPath !== null && newPath !== null && oldPath !== newPath,
        hunks: [],
        lineNo: i + 1,
      };
      i += 2;

      // Parse hunks
      while (i < lines.length) {
        const hl = lines[i];
        if (hl.startsWith('diff --git ')) break;
        if (hl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;

        if (hl.startsWith('@@')) {
          const hm = hl.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (!hm) throw new Exit2(`error: parse ${i + 1}`);
          const A = parseInt(hm[1], 10) - 1;
          const C = parseInt(hm[2], 10) - 1;
          const hunk: UnifiedHunk = { A, C, body: [], lineNo: i + 1 };
          i++;

          const rawBody: HunkLine[] = [];
          while (i < lines.length) {
            const bl = lines[i];
            if (bl.startsWith('@@')) break;
            if (bl.startsWith('diff --git ')) break;
            if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
            if (bl === '' || bl.startsWith(' ')) rawBody.push({ kind: ' ', text: bl === '' ? '' : bl.slice(1) });
            else if (bl.startsWith('-')) rawBody.push({ kind: '-', text: bl.slice(1) });
            else if (bl.startsWith('+')) rawBody.push({ kind: '+', text: bl.slice(1) });
            else if (bl.startsWith('\\')) rawBody.push({ kind: '\\', text: bl });
            else break;
            i++;
          }

          let end = rawBody.length;
          while (end > 0 && rawBody[end - 1].kind === ' ' && rawBody[end - 1].text === '') end--;
          hunk.body = rawBody.slice(0, end);
          sec.hunks.push(hunk);
          continue;
        }

        i++;
      }

      sections.push(sec);
      continue;
    }

    i++;
  }

  return sections;
}

/** Build O (old) and N (new) lines from hunk body, with context masks. */
function hunkON(body: HunkLine[]): {
  oLines: string[];   // context + minus
  nLines: string[];   // context + plus
  nContextMask: boolean[]; // which nLines are context
  oContextMask: boolean[]; // which oLines are context
  hasNoEOL: boolean;  // whether last body item is a \ line
  noEOLBeforeLast: boolean; // whether the \ is before the last + or - (preceding it)
} {
  const oLines: string[] = [];
  const nLines: string[] = [];
  const nContextMask: boolean[] = [];
  const oContextMask: boolean[] = [];

  // Track which lines have \ after them
  const noEOLAfter = new Set<number>(); // indices in body where next line is \
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === '\\' && i > 0) noEOLAfter.add(i - 1);
  }

  let hasNoEOL = false;
  if (body.length > 0 && body[body.length - 1].kind === '\\') hasNoEOL = true;

  for (let i = 0; i < body.length; i++) {
    const bl = body[i];
    if (bl.kind === ' ') {
      oLines.push(bl.text);
      oContextMask.push(true);
      nLines.push(bl.text);
      nContextMask.push(true);
    } else if (bl.kind === '-') {
      oLines.push(bl.text);
      oContextMask.push(false);
    } else if (bl.kind === '+') {
      nLines.push(bl.text);
      nContextMask.push(false);
    }
    // \ lines handled via hasNoEOL
  }

  return { oLines, nLines, nContextMask, oContextMask, hasNoEOL, noEOLBeforeLast: false };
}

function parseUnifiedEdits(text: string, lines: string[], strict: boolean): ((tree: Tree) => void)[] {
  const sections = parseUnifiedSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: ((tree: Tree) => void)[] = [];

  for (const sec of sections) {
    const capturedSec = sec;
    edits.push((tree: Tree) => {
      const sec = capturedSec;

      // Determine operation type
      const isCreate = sec.isCreate || sec.oldPath === null;
      const isDelete = sec.isDelete || sec.newPath === null;
      const isRename = !isCreate && !isDelete && sec.oldPath !== null && sec.newPath !== null && sec.oldPath !== sec.newPath;
      const isMod = !isCreate && !isDelete && !isRename && sec.oldPath !== null;

      const targetPath = isMod ? sec.oldPath! : (isCreate ? sec.newPath! : sec.oldPath!);

      // Safety checks
      if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
      if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);

      if (isCreate) {
        const p = sec.newPath!;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        // Build content from + lines of all hunks
        const plusLines: string[] = [];
        let noEOL = false;
        for (const hunk of sec.hunks) {
          const { nLines, nContextMask, hasNoEOL } = hunkON(hunk.body);
          for (let i = 0; i < nLines.length; i++) {
            if (!nContextMask[i]) plusLines.push(nLines[i]);
          }
          noEOL = hasNoEOL;
        }
        const content = plusLines.join('\n') + (noEOL ? '' : '\n');
        tree.now.set(p, content);
        return;
      }

      const oldP = sec.oldPath!;
      const existing = tree.get(oldP);
      if (existing === null) throw new Fail('missing', oldP);

      if (isDelete) {
        // hunks not read
        tree.now.set(oldP, null);
        return;
      }

      // Apply hunks (modify or rename)
      const { br, finalBreak: origFinalBreak } = fileLineInfo(existing.length > 0 ? existing : '\n');
      let fileLines = splitFile(existing);
      let d = 0; // cumulative delta
      let currentFinalBreak = origFinalBreak;

      for (const hunk of sec.hunks) {
        const { oLines, nLines, nContextMask, hasNoEOL } = hunkON(hunk.body);

        if (oLines.length === 0) {
          // Empty O: @@ -A,0 +C,B @@ inserts after 1-based line A (0-based index A + 1)
          const insertAt = Math.min(hunk.A + 1 + d, fileLines.length);
          fileLines = [...fileLines.slice(0, insertAt), ...nLines, ...fileLines.slice(insertAt)];
          d += nLines.length;
          // EOF handling for empty O
          if (hasNoEOL) {
            if (insertAt >= fileLines.length - nLines.length) currentFinalBreak = false;
          }
          continue;
        }

        // Find nearest occurrence to A-1+d
        const target = hunk.A + d;
        const [tier, pos] = findNearest(oLines, fileLines, target, strict);
        if (pos === -1) throw new Fail('no-match', oldP);

        // Check if hunk runs to end of file
        const hunkEndsAtEOF = (pos + oLines.length === fileLines.length);

        // Build new lines aligned with hunk.body (' ', '-', '+')
        const replacement: string[] = [];
        let bodyOldIdx = 0;
        for (const bl of hunk.body) {
          if (bl.kind === ' ') {
            replacement.push(fileLines[pos + bodyOldIdx] ?? bl.text);
            bodyOldIdx++;
          } else if (bl.kind === '-') {
            bodyOldIdx++;
          } else if (bl.kind === '+') {
            const l = bl.text;
            if (tier === 2 && oLines.length > 0) {
              const P = (oLines[0].match(/^[ \t]*/)?.[0]) ?? '';
              const F = (fileLines[pos].match(/^[ \t]*/)?.[0]) ?? '';
              if (l !== '' && l.trim() !== '' && l.startsWith(P)) {
                replacement.push(F + l.slice(P.length));
              } else {
                replacement.push(l);
              }
            } else {
              replacement.push(l);
            }
          }
        }

        fileLines = [...fileLines.slice(0, pos), ...replacement, ...fileLines.slice(pos + oLines.length)];
        d += nLines.length - oLines.length;

        // EOF / no-newline handling
        if (hasNoEOL) {
          // The \ follows the last + or context line; if hunk runs to end, result has no final break
          if (hunkEndsAtEOF) currentFinalBreak = false;
        } else if (hunkEndsAtEOF) {
          // Hunk ran to EOF and no \: keep final break as it was
          // (currentFinalBreak stays)
        }
      }

      const result = joinFile(fileLines, br, currentFinalBreak);
      if (isRename) {
        const newP = sec.newPath!;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        tree.now.set(oldP, null);
        tree.now.set(newP, result);
        tree.renames.push([oldP, newP]);
      } else {
        tree.now.set(oldP, result);
      }
    });
  }

  return edits;
}

// ─── SEARCH/REPLACE ──────────────────────────────────────────────────────────

function parseSearchReplaceEdits(lines: string[], strict: boolean): ((tree: Tree) => void)[] {
  const edits: ((tree: Tree) => void)[] = [];
  let i = 0;
  let lastPath: string | null = null;
  let lastReplaceEnd = -1; // line index after last REPLACE marker

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }

    const searchLine = i + 1; // 1-based line of SEARCH marker
    const searchStart = i + 1;

    // Find =======
    let sepIdx = -1;
    for (let j = searchStart; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') { sepIdx = j; break; }
    }
    if (sepIdx === -1) throw new Exit2(`error: parse ${i + 1}`);

    // Find >>>>>>> REPLACE
    let replaceEndIdx = -1;
    for (let j = sepIdx + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') { replaceEndIdx = j; break; }
    }
    if (replaceEndIdx === -1) throw new Exit2(`error: parse ${i + 1}`);

    // Find path: nearest non-blank, non-backtick line before SEARCH, after previous REPLACE
    let pathLine: string | null = null;
    for (let k = i - 1; k > lastReplaceEnd; k--) {
      const pl = lines[k];
      if (blank(pl)) continue;
      const trimmed = pl.trim();
      if (trimmed.startsWith('```')) continue;
      pathLine = trimmed;
      break;
    }

    if (pathLine === null) {
      if (lastPath === null) throw new Exit2(`error: parse ${i + 1}`);
      // use previous block's path
    } else {
      lastPath = pathLine;
    }

    const filePath = lastPath!;
    const searchLines = lines.slice(searchStart, sepIdx);
    const replaceLines = lines.slice(sepIdx + 1, replaceEndIdx);

    lastReplaceEnd = replaceEndIdx;
    i = replaceEndIdx + 1;

    const capturedPath = filePath;
    const capturedSearch = searchLines;
    const capturedReplace = replaceLines;

    edits.push((tree: Tree) => {
      const p = capturedPath;
      if (!safe(p)) throw new Fail('unsafe', p);

      if (capturedSearch.length === 0) {
        // Create: file must not exist
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const content = capturedReplace.join('\n') + '\n';
        tree.now.set(p, content);
        return;
      }

      // File must exist
      const existing = tree.get(p);
      if (existing === null) throw new Fail('missing', p);

      const { br, finalBreak } = fileLineInfo(existing.length > 0 ? existing : '\n');
      const fileLines = splitFile(existing);

      // Find occurrence — must be exactly one (across tiers)
      for (let t = 0; t <= (strict ? 0 : 2); t++) {
        const occ = matchLines(capturedSearch, fileLines, t);
        if (occ.length === 0) continue;
        if (occ.length > 1) throw new Fail('ambiguous', p);

        const pos = occ[0];
        // Build replacement: replace lines (no context in search/replace)
        let newLines: string[];
        if (t === 2) {
          const P = (capturedSearch[0].match(/^[ \t]*/)?.[0]) ?? '';
          const F = (fileLines[pos].match(/^[ \t]*/)?.[0]) ?? '';
          newLines = capturedReplace.map((l) => {
            if (l !== '' && l.trim() !== '' && l.startsWith(P)) return F + l.slice(P.length);
            return l;
          });
        } else {
          newLines = capturedReplace;
        }

        const result = [...fileLines.slice(0, pos), ...newLines, ...fileLines.slice(pos + capturedSearch.length)];
        tree.now.set(p, joinFile(result, br, finalBreak));
        return;
      }

      throw new Fail('no-match', p);
    });
  }

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ─── V4A patches ─────────────────────────────────────────────────────────────

function parseV4AEdits(lines: string[], strict: boolean): ((tree: Tree) => void)[] {
  // Find first non-blank line
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);

  // Find last non-blank line
  let lastNB = lines.length - 1;
  while (lastNB >= 0 && blank(lines[lastNB])) lastNB--;
  if (lastNB < 0 || lines[lastNB].trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const edits: ((tree: Tree) => void)[] = [];
  let i = firstNB + 1;

  while (i <= lastNB) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    if (line.trim() === '*** End Patch') break;

    // Add File
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      i++;
      const contentLines: string[] = [];
      while (i <= lastNB && !lines[i].startsWith('*** ')) {
        const cl = lines[i];
        if (blank(cl)) contentLines.push('');
        else if (cl.startsWith('+')) contentLines.push(cl.slice(1));
        else contentLines.push(cl);
        i++;
      }
      // Strip trailing blank lines from section
      while (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') contentLines.pop();

      const capP = p;
      const capContent = contentLines.slice();
      edits.push((tree: Tree) => {
        if (!safe(capP)) throw new Fail('unsafe', capP);
        if (tree.get(capP) !== null) throw new Fail('exists', capP);
        tree.now.set(capP, capContent.join('\n') + '\n');
      });
      continue;
    }

    // Delete File
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      // No body lines
      const capP = p;
      edits.push((tree: Tree) => {
        if (!safe(capP)) throw new Fail('unsafe', capP);
        if (tree.get(capP) === null) throw new Fail('missing', capP);
        tree.now.set(capP, null);
      });
      continue;
    }

    // Update File
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const sectionLineNo = i + 1;
      i++;

      // Check for Move to
      let moveTo: string | null = null;
      if (i <= lastNB && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }

      // Parse chunks
      interface V4AChunk {
        anchor: string | null;
        isEOF: boolean;
        body: Array<{ kind: ' ' | '-' | '+'; text: string }>;
      }

      const chunks: V4AChunk[] = [];
      let hasChunk = false;

      // If the first body line is a body line (not @@, not ***), it's the first chunk without an @@ header
      let firstChunkImplicit = false;
      if (i <= lastNB && !lines[i].startsWith('*** ') && !lines[i].startsWith('@@')) {
        if (!blank(lines[i])) {
          firstChunkImplicit = true;
        } else if (i + 1 <= lastNB && !blank(lines[i + 1]) && !lines[i + 1].startsWith('*** ') && !lines[i + 1].startsWith('@@')) {
          firstChunkImplicit = true;
        }
      }

      if (firstChunkImplicit) {
        // First chunk starts here (no @@ header = no anchor)
        const chunk: V4AChunk = { anchor: null, isEOF: false, body: [] };
        while (i <= lastNB && (!lines[i].startsWith('*** ') || lines[i].trim() === '*** End of File') && !lines[i].startsWith('@@')) {
          const cl = lines[i];
          if (cl.trim() === '*** End of File') { chunk.isEOF = true; i++; break; }
          if (blank(cl)) {
            let look = i + 1;
            while (look <= lastNB && blank(lines[look])) look++;
            if (look > lastNB || lines[look].startsWith('*** ') || lines[look].startsWith('@@') || lines[look].trim() === '*** End Patch') {
              break;
            }
            chunk.body.push({ kind: ' ', text: '' });
            i++;
            continue;
          }
          if (cl.startsWith(' ')) chunk.body.push({ kind: ' ', text: cl.slice(1) });
          else if (cl.startsWith('-')) chunk.body.push({ kind: '-', text: cl.slice(1) });
          else if (cl.startsWith('+')) chunk.body.push({ kind: '+', text: cl.slice(1) });
          else throw new Exit2(`error: parse ${i + 1}`);
          i++;
        }
        chunks.push(chunk);
        hasChunk = true;
      }

      // Parse @@ chunks
      while (i <= lastNB && !lines[i].startsWith('*** ') && lines[i].trim() !== '*** End Patch') {
        if (blank(lines[i])) { i++; continue; }
        if (!lines[i].startsWith('@@')) {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        const anchorText = lines[i].slice(2).trim();
        const anchor = anchorText === '' ? null : anchorText;
        i++;
        const chunk: V4AChunk = { anchor, isEOF: false, body: [] };

        while (i <= lastNB && (!lines[i].startsWith('*** ') || lines[i].trim() === '*** End of File') && !lines[i].startsWith('@@')) {
          const cl = lines[i];
          if (cl.trim() === '*** End of File') { chunk.isEOF = true; i++; break; }
          if (blank(cl)) {
            let look = i + 1;
            while (look <= lastNB && blank(lines[look])) look++;
            if (look > lastNB || lines[look].startsWith('*** ') || lines[look].startsWith('@@') || lines[look].trim() === '*** End Patch') {
              break;
            }
            chunk.body.push({ kind: ' ', text: '' });
            i++;
            continue;
          }
          if (cl.startsWith(' ')) chunk.body.push({ kind: ' ', text: cl.slice(1) });
          else if (cl.startsWith('-')) chunk.body.push({ kind: '-', text: cl.slice(1) });
          else if (cl.startsWith('+')) chunk.body.push({ kind: '+', text: cl.slice(1) });
          else throw new Exit2(`error: parse ${i + 1}`);
          i++;
        }

        chunks.push(chunk);
        hasChunk = true;
      }

      if (!hasChunk && moveTo === null) throw new Exit2(`error: parse ${sectionLineNo}`);

      const capP = p;
      const capMoveTo = moveTo;
      const capChunks = chunks;

      edits.push((tree: Tree) => {
        if (!safe(capP)) throw new Fail('unsafe', capP);
        const existing = tree.get(capP);
        if (existing === null) throw new Fail('missing', capP);

        if (capMoveTo !== null) {
          if (!safe(capMoveTo)) throw new Fail('unsafe', capMoveTo);
          if (tree.get(capMoveTo) !== null) throw new Fail('exists', capMoveTo);
        }

        const { br, finalBreak: origFinalBreak } = fileLineInfo(existing.length > 0 ? existing : '\n');
        let fileLines = splitFile(existing);
        let cursor = 0;
        let currentFinalBreak = origFinalBreak;

        for (const chunk of capChunks) {
          // Find anchor
          if (chunk.anchor !== null) {
            const anchorLine = chunk.anchor;
            // Find first line >= cursor equal to anchor (three-tier)
            let found = -1;
            for (let t = 0; t <= (strict ? 0 : 2); t++) {
              const normA = t === 0 ? anchorLine : t === 1 ? anchorLine.replace(/[ \t]+$/, '') : anchorLine.trim();
              for (let k = cursor; k < fileLines.length; k++) {
                const normF = t === 0 ? fileLines[k] : t === 1 ? fileLines[k].replace(/[ \t]+$/, '') : fileLines[k].trim();
                if (normF === normA) { found = k; break; }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', capP);
            cursor = found + 1; // cursor moves past the anchor line
          }

          // Build O and N
          const oLines: string[] = [];
          const nLines: string[] = [];
          const nContextMask: boolean[] = [];

          for (const bl of chunk.body) {
            if (bl.kind === ' ') {
              oLines.push(bl.text);
              nLines.push(bl.text);
              nContextMask.push(true);
            } else if (bl.kind === '-') {
              oLines.push(bl.text);
            } else if (bl.kind === '+') {
              nLines.push(bl.text);
              nContextMask.push(false);
            }
          }

          if (oLines.length === 0) {
            // Empty O: insert at cursor (or end for EOF chunk)
            const insertAt = chunk.isEOF ? fileLines.length : cursor;
            fileLines = [...fileLines.slice(0, insertAt), ...nLines, ...fileLines.slice(insertAt)];
            cursor = insertAt + nLines.length;
            continue;
          }

          // Find first occurrence of O at or after cursor
          let foundPos = -1;
          let foundTier = -1;

          for (let t = 0; t <= (strict ? 0 : 2); t++) {
            const occ = matchLines(oLines, fileLines, t);
            for (const pos of occ) {
              if (pos < cursor) continue;
              if (chunk.isEOF && pos + oLines.length !== fileLines.length) continue;
              foundPos = pos;
              foundTier = t;
              break;
            }
            if (foundPos >= 0) break;
          }

          if (foundPos < 0) throw new Fail('no-match', capP);

          // Build replacement aligned with chunk.body (' ', '-', '+')
          const replacement: string[] = [];
          let bodyOldIdx = 0;
          for (const bl of chunk.body) {
            if (bl.kind === ' ') {
              replacement.push(fileLines[foundPos + bodyOldIdx] ?? bl.text);
              bodyOldIdx++;
            } else if (bl.kind === '-') {
              bodyOldIdx++;
            } else if (bl.kind === '+') {
              const l = bl.text;
              if (foundTier === 2 && oLines.length > 0) {
                const P = (oLines[0].match(/^[ \t]*/)?.[0]) ?? '';
                const F = (fileLines[foundPos].match(/^[ \t]*/)?.[0]) ?? '';
                if (l !== '' && l.trim() !== '' && l.startsWith(P)) {
                  replacement.push(F + l.slice(P.length));
                } else {
                  replacement.push(l);
                }
              } else {
                replacement.push(l);
              }
            }
          }

          fileLines = [...fileLines.slice(0, foundPos), ...replacement, ...fileLines.slice(foundPos + oLines.length)];
          cursor = foundPos + replacement.length;
        }

        const result = joinFile(fileLines, br, currentFinalBreak);

        if (capMoveTo !== null) {
          tree.now.set(capP, null);
          tree.now.set(capMoveTo, result);
          tree.renames.push([capP, capMoveTo]);
        } else {
          tree.now.set(capP, result);
        }
      });
      continue;
    }

    if (line.trim() === '*** End of File') { i++; continue; }

    // Any other non-blank line inside Begin/End Patch is an error
    throw new Exit2(`error: parse ${i + 1}`);
  }

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;

  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice(9);
        if (format !== null) return { code: 2, out: ['error: usage'] };
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }

  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: ((tree: Tree) => void)[];
  try {
    switch (kind) {
      case 'json':
        edits = jsonEdits(text, lines);
        break;
      case 'unified':
        edits = parseUnifiedEdits(text, lines, strict);
        break;
      case 'search-replace':
        edits = parseSearchReplaceEdits(lines, strict);
        break;
      case 'v4a':
        edits = parseV4AEdits(lines, strict);
        break;
      default:
        throw new Exit2('error: format');
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];

  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeOrig = new Map(tree.orig);
    const beforeRenames = [...tree.renames];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      // Roll back this edit
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.orig.clear();
      for (const [k, v] of beforeOrig) tree.orig.set(k, v);
      tree.renames.length = 0;
      tree.renames.push(...beforeRenames);
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const rows: string[] = [];
  const renames = tree.renames;
  const renameOlds = new Set(renames.map((r) => r[0]));
  const renameNews = new Set(renames.map((r) => r[1]));

  // Collect all paths that changed
  const allPaths = new Set([...tree.now.keys()]);
  for (const p of allPaths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renameOlds.has(p)) continue; // emitted as R line keyed by new path
    if (renameNews.has(p)) {
      const pair = renames.find((r) => r[1] === p)!;
      rows.push(`R ${pair[0]} -> ${p}`);
      continue;
    }
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }

  // Sort by path (R sorts by new path)
  rows.sort((a, b) => {
    const pa = a.startsWith('R ') ? a.slice(2).split(' -> ')[1]! : a.slice(2);
    const pb = b.startsWith('R ') ? b.slice(2).split(' -> ')[1]! : b.slice(2);
    return Buffer.compare(Buffer.from(pa), Buffer.from(pb));
  });

  if (!check) {
    for (const row of rows) {
      if (row.startsWith('R ')) {
        const parts = row.slice(2).split(' -> ');
        const oldP = parts[0]!;
        const newP = parts[1]!;
        rmSync(oldP, { force: true });
        const content = tree.now.get(newP);
        if (content != null) {
          mkdirSync(dirname(newP), { recursive: true });
          writeFileSync(newP, content);
        }
      } else {
        const p = row.slice(2);
        const now = tree.now.get(p);
        if (now === null || now === undefined) {
          rmSync(p, { force: true });
        } else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      }
    }
  }

  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

/** Trial env: the kit's runner reads the checks from the env and runs this file on each one, without this variable. */
const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
