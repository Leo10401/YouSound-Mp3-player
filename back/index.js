import express from 'express';
import cors from 'cors';
import { YtDlp } from 'ytdlp-nodejs';
import NodeCache from 'node-cache';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 5000;
let ytDlp;

// Initialize yt-dlp with a bit more robustness
try {
  const binPath = path.join(__dirname, 'node_modules', 'ytdlp-nodejs', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  ytDlp = new YtDlp({ binaryPath: binPath });
  console.log('Successfully initialized YtDlp with binary path:', binPath);
} catch (err) {
  console.error('Failed to initialize YtDlp:', err);
  // Continue anyway - we'll check for ytDlp before using it
}

const audioCache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

app.use(cors());

// Add a health check endpoint
app.get('/', (req, res) => {
  res.send('Audio server is running!');
});

// Add a diagnostic endpoint
app.get('/debug', async (req, res) => {
  try {
    // Check if ytDlp is initialized
    const ytDlpStatus = ytDlp ? 'Initialized' : 'Not initialized';
    
    // Check binary existence
    const binPath = path.join(__dirname, 'node_modules', 'ytdlp-nodejs', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    let binExists = false;
    try {
      const { statSync } = await import('fs');
      binExists = statSync(binPath).isFile();
    } catch (err) {
      // File doesn't exist
    }
    
    // Try to get yt-dlp version
    let ytDlpVersion = 'Unknown';
    try {
      const { stdout } = await execPromise(`"${binPath}" --version`);
      ytDlpVersion = stdout.trim();
    } catch (err) {
      ytDlpVersion = `Error: ${err.message}`;
    }
    
    // Return diagnostics
    res.json({
      ytDlpStatus,
      binPath,
      binExists,
      ytDlpVersion,
      platform: process.platform,
      nodeVersion: process.version
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.get('/audio/:videoId', async (req, res) => {
  if (!ytDlp) {
    return res.status(500).send('yt-dlp not properly initialized');
  }

  const { videoId } = req.params;
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    let buffer = audioCache.get(videoId);

    if (!buffer) {
      console.log(`Fetching audio for video ID: ${videoId}`);
      
      // First, try to get info to see if the video exists and is accessible
      try {
        console.log('Getting video info...');
        const info = await ytDlp.getInfoAsync(url);
        console.log('Video info retrieved:', info.title);
      } catch (infoErr) {
        console.error('Failed to get video info:', infoErr);
        return res.status(404).send(`Could not access video: ${infoErr.message}`);
      }
      
      console.log('Downloading audio file...');
      const file = await ytDlp.getFileAsync(url, {
        format: {
          filter: 'audioonly',
          type: 'mp3',
          quality: 'highest',
        },
        filename: `${videoId}.mp3`,
      });

      console.log('Audio file downloaded, creating buffer...');
      buffer = Buffer.from(await file.arrayBuffer());
      console.log(`Buffer created, size: ${buffer.length} bytes`);
      audioCache.set(videoId, buffer);
    } else {
      console.log(`Using cached audio for video ID: ${videoId}`);
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
    res.status(500).send(`Failed to load audio: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`🎧 Audio server running on http://localhost:${PORT}`);
});