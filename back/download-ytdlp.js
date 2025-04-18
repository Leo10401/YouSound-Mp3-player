import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Define the binary directory
const BIN_DIR = path.join(__dirname, 'node_modules', 'ytdlp-nodejs', 'bin');

// Ensure the bin directory exists
if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  console.log(`Created directory: ${BIN_DIR}`);
}

// Platform-specific yt-dlp binary URL
const platform = process.platform;
const isWin = platform === 'win32';
const ytdlpFilename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const ytdlpUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpFilename}`;
const ytdlpPath = path.join(BIN_DIR, ytdlpFilename);

console.log(`Downloading yt-dlp from ${ytdlpUrl}...`);

// Download the yt-dlp binary
const file = fs.createWriteStream(ytdlpPath);
https.get(ytdlpUrl, (response) => {
  response.pipe(file);
  file.on('finish', () => {
    file.close(() => {
      // Make the binary executable (not needed for Windows)
      if (!isWin) {
        fs.chmodSync(ytdlpPath, 0o755);
        console.log(`Made ${ytdlpPath} executable`);
      }
      console.log(`Successfully downloaded yt-dlp to ${ytdlpPath}`);
    });
  });
}).on('error', (err) => {
  fs.unlink(ytdlpPath, () => {});
  console.error(`Error downloading yt-dlp: ${err.message}`);
  process.exit(1);
});