# CardMap

A little tool I'm building to help with managing media: keeping track of my files as they come off SD cards and where I put them.

## What it does

- **Reads camera cards** and lists what is on them by date or by card folder, with previews. It never writes to the card.
- **Imports with verified copies.** Files are copied to a main folder and an optional backup folder, and every copy is checked against the card by checksum before it is recorded.
- **Keeps a map of where things are.** Each file's known locations are stored in a local database, so you can look up a date, a shoot or a file and see every folder it lives in.
- **Matches card files to local files.** It can search your folders for files that are identical to the ones on a card, even if they were renamed.
- **Checks Lightroom.** It reads Lightroom's catalog (read-only) and tells you which card files are already in your Lightroom library.
- **Says when a card is safe to format:** only when every file on it has at least two verified copies.

## Running it

Windows only for now. Needs [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
```

```bash
npm start
```

## Status

Early and changing. It is a personal project, built for my own workflow.
