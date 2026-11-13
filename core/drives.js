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

module.exports = { listCardDrives, listDrives };
