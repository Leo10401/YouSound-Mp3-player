import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);
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
  file.on('finish', async () => {
    file.close(async () => {
      // Make the binary executable (not needed for Windows)
      if (!isWin) {
        fs.chmodSync(ytdlpPath, 0o755);
        console.log(`Made ${ytdlpPath} executable`);
      }
      
      console.log(`Successfully downloaded yt-dlp to ${ytdlpPath}`);
      
      // Check if the binary works
      try {
        const { stdout } = await execPromise(`"${ytdlpPath}" --version`);
        console.log(`yt-dlp version: ${stdout.trim()}`);
        
        // Test a simple info command
        const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // A well-known video
        console.log(`Testing yt-dlp with URL: ${testUrl}`);
        
        const { stdout: testOutput } = await execPromise(`"${ytdlpPath}" --dump-json --quiet "${testUrl}"`);
        const videoInfo = JSON.parse(testOutput);
        console.log(`yt-dlp test successful! Video title: ${videoInfo.title}`);
      } catch (err) {
        console.error(`Error testing yt-dlp: ${err.message}`);
        
        if (err.message.includes('JSON')) {
          console.error('JSON parsing error. Raw output:', err.stdout);
        }
      }
    });
  });
}).on('error', (err) => {
  fs.unlink(ytdlpPath, () => {});
  console.error(`Error downloading yt-dlp: ${err.message}`);
  process.exit(1);
});

// Also try to check if FFmpeg is installed on the system
try {
  const { stdout } = await execPromise('ffmpeg -version');
  console.log('FFmpeg is available:', stdout.split('\n')[0]);
} catch (err) {
  console.warn('FFmpeg might not be installed:', err.message);
  console.log('Trying to install FFmpeg (only works on some systems)...');
  
  try {
    if (platform === 'linux') {
      await execPromise('apt-get update && apt-get install -y ffmpeg');
      console.log('FFmpeg installed successfully');
    } else {
      console.log('Automatic FFmpeg installation not supported for this platform');
    }
  } catch (installErr) {
    console.error('Failed to install FFmpeg:', installErr.message);
  }
}