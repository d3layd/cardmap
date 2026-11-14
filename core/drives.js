const { execFile } = require('node:child_process');
const fs = require('node:fs');

const PS =
  'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,VolumeSerialNumber,DriveType,Size,FreeSpace | ConvertTo-Json -Compress';

function queryDisks() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const parsed = JSON.parse(stdout || '[]');
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/**
 * Mounted camera cards: removable drives with media in them, plus any other
 * non-system drive that has a DCIM folder (some readers report as fixed disks).
 */
/** Every volume connected right now, with the serial number that identifies it whatever its letter. */
function volumesFrom(disks) {
  return disks
    .filter((d) => d.DeviceID && d.VolumeSerialNumber)
    .map((d) => ({ letter: d.DeviceID, serial: d.VolumeSerialNumber, label: d.VolumeName || '' }));
}

/** One query for both: { cards, volumes }. */
async function listDrives() {
  const disks = await queryDisks();
  return { cards: cardsFrom(disks), volumes: volumesFrom(disks) };
}

async function listCardDrives() {
  return cardsFrom(await queryDisks());
}

function cardsFrom(disks) {
  const out = [];
  for (const d of disks) {
    if (!d.DeviceID || !d.Size || !d.VolumeSerialNumber) continue;
    const letter = d.DeviceID; // "E:"
    if (letter.toUpperCase() === (process.env.SystemDrive || 'C:').toUpperCase()) continue;
    const removable = d.DriveType === 2;
    const hasDcim = fs.existsSync(`${letter}\\DCIM`);
    if (!removable && !hasDcim) continue;
    out.push({
      letter,
      label: d.VolumeName || 'Untitled',
      serial: d.VolumeSerialNumber,
      size: Number(d.Size),
      free: Number(d.FreeSpace || 0),
    });
  }
  return out;
}

const PS_DISKS =
  "Get-Partition | Where-Object DriveLetter | ForEach-Object { $d = Get-Disk -Number $_.DiskNumber; [pscustomobject]@{ Letter = \"$($_.DriveLetter):\"; Disk = $_.DiskNumber; Bus = \"$($d.BusType)\"; Location = \"$($d.Location)\"; Serial = \"$($d.SerialNumber)\".Trim(); Model = \"$($d.FriendlyName)\" } } | ConvertTo-Json -Compress";

/**
 * Which physical disk each drive letter lives on. Two letters on the same disk (two
 * partitions), or a virtual disk stored as a file on another drive, count as one disk:
 * if that disk fails, both are lost.
 * Returns { 'E:': { id, model, virtualOf } } where virtualOf is the letter holding the file.
 */
function physicalDrives() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_DISKS], { windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err) return resolve({});
      let rows = [];
      try {
        rows = JSON.parse(stdout || '[]');
        if (!Array.isArray(rows)) rows = [rows];
      } catch {
        return resolve({});
      }
      const out = {};
      for (const r of rows) out[r.Letter] = { id: `disk:${r.Serial || `#${r.Disk}`}`, model: r.Model, bus: r.Bus, location: r.Location, virtualOf: null };
      // A virtual disk (a .vhdx file) belongs to the disk that holds its file.
      for (const r of rows) {
        if (!/virtual/i.test(r.Bus)) continue;
        const m = /^([A-Za-z]:)\\/.exec(r.Location || '');
        const host = m && out[m[1].toUpperCase()];
        if (host) out[r.Letter] = { ...out[r.Letter], id: host.id, virtualOf: m[1].toUpperCase() };
      }
      resolve(out);
    });
  });
}

module.exports = { listCardDrives, listDrives, physicalDrives };
