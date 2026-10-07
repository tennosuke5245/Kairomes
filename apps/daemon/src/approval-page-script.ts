// DOM-free helpers for the legacy approval page, which is one self-contained HTML string and
// cannot load modules. approval-page-script.test.ts evaluates this exact text.
//
// `parseDiff` mirrors parseUnifiedDiff from @kairomes/protocol/diff-lines (without line
// numbers) and the test keeps both in parity. `diffRows` turns a review diff into display rows
// and never drops a line: inside a hunk every row is content, whatever its prefix, and when the
// parsed files do not match the reviewed files exactly every raw line is shown instead.
// `fileLine` labels one reviewed file. `quoted` shows one argv element unambiguously (empty,
// spaces, controls, bidi marks) and `visibleSegments` splits text so invisible or reordering
// characters render as escapes.
export const approvalPageScript = String.raw`
const invisible = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const named = {'\n': '\\n', '\t': '\\t', '\r': '\\r'};
const codePoint = (character) => character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
function quoted(value) {
  return JSON.stringify(String(value)).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) => '\\u' + codePoint(character));
}
function visibleSegments(text) {
  const segments = [];
  let plain = '';
  for (const character of String(text)) {
    if (character !== '\t' && invisible.test(character)) {
      if (plain) segments.push({text: plain});
      plain = '';
      segments.push({text: named[character] || 'U+' + codePoint(character), escape: true});
    } else plain += character;
  }
  if (plain) segments.push({text: plain});
  return segments;
}
const statusLabels = {modified: '修改', added: '新檔案', deleted: '刪除', renamed: '重新命名'};
const operationLabels = {edit: '修改', write: '寫入', delete: '刪除'};
// One reviewed file per line, labelled like the side panel: 「寫入 src/new.ts」.
function fileLine(file) {
  return (Object.hasOwn(operationLabels, file.operation) ? operationLabels[file.operation] : String(file.operation)) + ' ' + file.path;
}
function parseDiff(text) {
  const rows = String(text || '').split(/\r?\n/);
  if (rows[rows.length - 1] === '') rows.pop();
  const standardHunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const files = [];
  let file, fileHasHunk = false, hunk, binaryPatch = false, previousBlank = true;
  const unquote = (value) => {
    if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
    const bytes = [];
    const encoder = new TextEncoder();
    const body = value.slice(1, -1);
    const escapes = {n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8};
    for (let index = 0; index < body.length; index++) {
      const character = body[index];
      if (character !== '\\') { bytes.push(...encoder.encode(character)); continue; }
      const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
      if (octal) { bytes.push(Number.parseInt(octal[0], 8)); index += 3; continue; }
      const next = body[index + 1] || '';
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index++;
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  };
  const headerPath = (raw) => {
    const value = unquote(raw.split('\t')[0] || '');
    return value === '/dev/null' ? null : value.replace(/^[ab]\//, '');
  };
  const hunkLabel = (row) => {
    const replacement = /^@@ exact replacement (\d+)( · all matches)? @@$/.exec(row);
    if (replacement) return '替換 ' + replacement[1] + (replacement[2] ? ' · 全部相符處' : '');
    if (row === '@@ create file @@') return '新檔案';
    if (row === '@@ delete file @@') return '刪除檔案';
    const focused = /^@@ (\d+) @@$/.exec(row);
    if (focused) return '第 ' + focused[1] + ' 行起';
    const standard = standardHunk.exec(row);
    if (standard) return '第 ' + (Number(standard[3]) || Number(standard[1]) || 1) + ' 行起';
    return undefined;
  };
  const startFile = (path, previousPath) => {
    const renamed = previousPath !== undefined && previousPath !== path;
    file = {path, status: renamed ? 'renamed' : 'modified', binary: false, lines: []};
    if (renamed) file.previousPath = previousPath;
    files.push(file);
    fileHasHunk = false;
    hunk = undefined;
    binaryPatch = false;
    return file;
  };
  const current = () => file || startFile('');
  const setPaths = (target, oldPath, newPath) => {
    if (oldPath === null && newPath !== null) { target.path = newPath; target.status = 'added'; }
    else if (newPath === null && oldPath !== null) { target.path = oldPath; target.status = 'deleted'; }
    else if (oldPath !== null && newPath !== null) {
      target.path = newPath;
      if (oldPath !== newPath) { target.previousPath = oldPath; target.status = 'renamed'; }
    }
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const blank = previousBlank;
    previousBlank = row === '';
    const insideCounted = hunk !== undefined && hunk.counted && (hunk.oldLeft > 0 || hunk.newLeft > 0);
    if (!insideCounted) {
      if (row.startsWith('diff --git ')) {
        const match = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(row);
        startFile(unquote(match ? match[2] : ''), match ? unquote(match[1]) : undefined);
        continue;
      }
      // A ---/+++ pair opens a file. Inside a review hunk it must follow the blank separator,
      // so a removed line "-- x" followed by an added line "++ y" stays content.
      const next = rows[index + 1];
      if (row.startsWith('--- ') && next !== undefined && next.startsWith('+++ ') && (hunk === undefined || hunk.counted || blank)) {
        const target = file && !fileHasHunk ? file : startFile('');
        setPaths(target, headerPath(row.slice(4)), headerPath(next.slice(4)));
        index++;
        previousBlank = false;
        hunk = undefined;
        continue;
      }
      if (row.startsWith('@@')) {
        const target = current();
        fileHasHunk = true;
        binaryPatch = false;
        const label = hunkLabel(row);
        target.lines.push(label === undefined ? {kind: 'hunk', text: row} : {kind: 'hunk', text: row, label});
        const standard = standardHunk.exec(row);
        if (standard) hunk = {counted: true, oldLeft: standard[2] === undefined ? 1 : Number(standard[2]), newLeft: standard[4] === undefined ? 1 : Number(standard[4])};
        else {
          if (row === '@@ create file @@') target.status = 'added';
          else if (row === '@@ delete file @@') target.status = 'deleted';
          hunk = {counted: false, oldLeft: 0, newLeft: 0};
        }
        continue;
      }
    }
    const target = current();
    if (hunk === undefined || (hunk.counted && !insideCounted)) {
      // File metadata between headers and hunks; headers become the file's path and status.
      if (row === '' || binaryPatch || row.startsWith('index ')) continue;
      if (row.startsWith('new file mode')) target.status = 'added';
      else if (row.startsWith('deleted file mode')) target.status = 'deleted';
      else if (row.startsWith('rename from ') || row.startsWith('copy from ')) {
        target.previousPath = unquote(row.replace(/^(rename|copy) from /, ''));
        target.status = 'renamed';
      } else if (row.startsWith('rename to ') || row.startsWith('copy to ')) target.path = unquote(row.replace(/^(rename|copy) to /, ''));
      else if (row === 'GIT binary patch') { target.binary = true; binaryPatch = true; }
      else if (/^Binary files .* differ$/.test(row)) {
        target.binary = true;
        const paths = /^Binary files (.+) and (.+) differ$/.exec(row);
        if (paths && !target.path) setPaths(target, headerPath(paths[1]), headerPath(paths[2]));
      } else if (!target.path && !target.lines.length && !fileHasHunk && /^[+\- ]/.test(row)) {
        hunk = {counted: false, oldLeft: 0, newLeft: 0};
        index--;
        previousBlank = blank;
      } else target.lines.push({kind: 'meta', text: row});
      continue;
    }
    // Inside a hunk every row is content, whatever it starts with.
    if (row === '' && !insideCounted) continue;
    const sign = row[0] || ' ';
    if (sign === '\\') target.lines.push({kind: 'meta', text: row});
    else if (sign === '+') { target.lines.push({kind: 'add', text: row.slice(1)}); if (hunk.counted) hunk.newLeft--; }
    else if (sign === '-') { target.lines.push({kind: 'del', text: row.slice(1)}); if (hunk.counted) hunk.oldLeft--; }
    else if (sign === ' ' || row === '') {
      target.lines.push({kind: 'context', text: row.slice(1)});
      if (hunk.counted) { hunk.oldLeft--; hunk.newLeft--; }
    } else target.lines.push({kind: 'meta', text: row});
  }
  return files;
}
function diffRows(text, reviewed) {
  const files = parseDiff(text);
  const expected = (reviewed || []).map((entry) => entry.path).sort();
  const parsed = files.map((entry) => entry.path).sort();
  // The sections must cover exactly the reviewed files; otherwise show every raw line.
  if (parsed.length !== expected.length || parsed.some((path, index) => path !== expected[index]))
    return String(text || '').split(/\r?\n/).map((line) => ({kind: 'raw', text: line}));
  const rows = [];
  for (const entry of files) {
    const path = entry.previousPath ? entry.previousPath + ' → ' + entry.path : entry.path;
    rows.push({kind: 'file', text: path + ' · ' + statusLabels[entry.status]});
    if (entry.binary) rows.push({kind: 'note', text: '二進位檔案，無法顯示內容。'});
    for (const line of entry.lines)
      rows.push(line.kind === 'hunk' ? {kind: 'hunk', text: line.label || line.text} : {kind: line.kind, text: line.text});
  }
  return rows;
}
`;
