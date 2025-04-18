import express from 'express';
import cors from 'cors';
import { YtDlp, BIN_DIR } from 'ytdlp-nodejs';
import NodeCache from 'node-cache';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

dotenv.config();
const execPromise = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;
const audioCache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

app.use(cors());

// First, ensure binary directory exists
if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

// Path for yt-dlp binary
const ytdlpPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// Download and initialize yt-dlp
async function initializeYtDlp() {
  if (!fs.existsSync(ytdlpPath)) {
    console.log('yt-dlp binary not found. Downloading...');
    
    // Get the appropriate download URL based on platform
    const platform = process.platform === 'win32' ? 'win_exe' : 
                      process.platform === 'darwin' ? 'macos' : 'linux';
    
    // Latest stable version URL
    const ytdlpUrl = process.platform === 'win32' 
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    
    try {
      // Download yt-dlp binary
      await execPromise(`curl -L ${ytdlpUrl} -o ${ytdlpPath}`);
      console.log('yt-dlp downloaded successfully');
      
      // Make it executable (except on Windows)
      if (process.platform !== 'win32') {
        await execPromise(`chmod +x ${ytdlpPath}`);
        console.log('yt-dlp permissions set');
      }
    } catch (error) {
      console.error('Error downloading yt-dlp:', error);
      throw error;
    }
  } else {
    console.log('yt-dlp binary already exists');
  }
  
  // Return initialized YtDlp instance
  return new YtDlp({ binaryPath: ytdlpPath });
}

// Initialize server only after yt-dlp is ready
let ytDlp;
initializeYtDlp()
  .then(ytDlpInstance => {
    ytDlp = ytDlpInstance;
    startServer();
  })
  .catch(error => {
    console.error('Failed to initialize yt-dlp:', error);
    process.exit(1);
  });

// Define routes and start server
function startServer() {
  app.get('/audio/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    try {
      let buffer = audioCache.get(videoId);

      if (!buffer) {
        const file = await ytDlp.getFileAsync(url, {
          format: {
            filter: 'audioonly',
            type: 'mp3',
            quality: 'highest',
          },
          filename: `${videoId}.mp3`,
        });

        buffer = Buffer.from(await file.arrayBuffer());
        audioCache.set(videoId, buffer);
      }

      const total = buffer.length;
      const range = req.headers.range;

      if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : total - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'audio/mpeg',
        });

        res.end(buffer.slice(start, end + 1));
      } else {
        res.writeHead(200, {
          'Content-Length': total,
          'Content-Type': 'audio/mpeg',
        });

        res.end(buffer);
      }
    } catch (err) {
      console.error('Audio fetch error:', err);
      res.status(500).send('Failed to load audio.');
    }
  });

  // Add health check endpoint
  app.get('/health', (_, res) => {
    res.status(200).send('OK');
  });

  app.listen(PORT, () => {
    console.log(`🎧 Audio server running on port ${PORT}`);
  });
}