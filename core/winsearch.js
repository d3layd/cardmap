// Ask Windows Search which files changed, instead of listing a whole drive.
//
// Windows keeps its own index of file names, sizes and dates (the one behind the search
// box in Explorer). It can say in a fraction of a second which photo and video files on a
// drive were created or modified since a given time, including while CardMap was closed.
// It does not report deletions, can lag behind, and skips places excluded in Windows'
// settings, so CardMap still walks each drive in full now and then.
//
// Queried through PowerShell (ADO and the Search.CollatorDSO provider), so no extra
// modules are needed. Read-only.
const { execFile } = require('node:child_process');

const ps = (script, timeout = 120000) =>
  new Promise((resolve, reject) => {
    const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout, maxBuffer: 256 << 20, windowsHide: true }, (err, out) =>
      err ? reject(err) : resolve(String(out))
    );
  });

const sqlText = (s) => String(s).replace(/'/g, "''");
// Windows Search scopes use forward slashes: file:J:/Projects/
const scopeOf = (folder) => `file:${folder.replace(/\\/g, '/').replace(/\/?$/, '/')}`;

const OPEN = `$c = New-Object -ComObject ADODB.Connection
$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")`;

/** Does Windows Search hold anything for this drive or folder? */
async function covers(folder) {
  try {
    const out = await ps(`${OPEN}
$rs = $c.Execute("SELECT TOP 1 System.ItemPathDisplay FROM SystemIndex WHERE SCOPE='${sqlText(scopeOf(folder))}'")
if (-not $rs.EOF) { 'yes' } else { 'no' }
$c.Close()`, 30000);
    return out.trim().endsWith('yes');
  } catch {
    return false; // the Search service is off, or this is not Windows
  }
}

/**
 * Paths of files under `folder` with one of `exts` (without dots) that were created or
 * modified after `since` (a Date). Returns null if Windows Search could not be asked.
 */
async function changedSince(folder, since, exts) {
  const when = since.toISOString().replace('T', ' ').slice(0, 19); // Windows Search compares in UTC
  const extClause = [...exts].map((e) => `System.FileExtension = '.${sqlText(e)}'`).join(' OR ');
  const sql = `SELECT System.ItemPathDisplay FROM SystemIndex WHERE SCOPE='${sqlText(scopeOf(folder))}' AND (${extClause}) AND (System.DateModified > '${when}' OR System.DateCreated > '${when}')`;
  try {
    const out = await ps(`${OPEN}
$rs = $c.Execute("${sql.replace(/"/g, '`"')}")
while (-not $rs.EOF) { [Console]::Out.WriteLine($rs.Fields.Item(0).Value); $rs.MoveNext() }
$c.Close()
'--done--'`);
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[lines.length - 1] !== '--done--') return null;
    return lines.slice(0, -1);
  } catch {
    return null;
  }
}

module.exports = { covers, changedSince };
