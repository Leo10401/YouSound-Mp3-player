import express from 'express';
import cors from 'cors';
import { YtDlp, BIN_DIR } from 'ytdlp-nodejs';
import NodeCache from 'node-cache';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

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

// Create a config directory for yt-dlp
const configDir = path.join(os.tmpdir(), 'yt-dlp-config');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Create a yt-dlp config file with increased rate limit and additional options
const configPath = path.join(configDir, 'config');
const configContent = `
--geo-bypass
--no-check-certificate
--extractor-args "youtube:player_client=android,web"
--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36"
--add-header "Accept-Language:en-US,en;q=0.9"
--ignore-errors
--no-warnings
--no-progress
`;

fs.writeFileSync(configPath, configContent);

// Download and initialize yt-dlp
async function initializeYtDlp() {
  if (!fs.existsSync(ytdlpPath)) {
    console.log('yt-dlp binary not found. Downloading...');
    
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
  
  // Return initialized YtDlp instance with config path
  return new YtDlp({ 
    binaryPath: ytdlpPath
  });
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

// Helper function to extract audio using raw command
async function extractAudio(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(os.tmpdir(), `${videoId}.mp3`);
  
  // Remove existing file if it exists
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  try {
    // Use the yt-dlp command directly with all the necessary options
    const command = `"${ytdlpPath}" "${url}" --config-location "${configPath}" -f "bestaudio" -x --audio-format mp3 --audio-quality 0 -o "${outputPath}"`;
    
    console.log(`Executing command: ${command}`);
    await execPromise(command);
    
    // Read the file and return as buffer
    if (fs.existsSync(outputPath)) {
      const buffer = fs.readFileSync(outputPath);
      // Clean up file after reading
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      throw new Error('Output file not created');
    }
  } catch (error) {
    console.error('Error extracting audio with command:', error);
    throw error;
  }
}

// Define routes and start server
function startServer() {
  app.get('/audio/:videoId', async (req, res) => {
    const { videoId } = req.params;
    
    try {
      let buffer = audioCache.get(videoId);

      if (!buffer) {
        try {
          // First try with the YtDlp class
          console.log(`Fetching audio for video ID: ${videoId}`);
          const file = await ytDlp.getFileAsync(`https://www.youtube.com/watch?v=${videoId}`, {
            format: {
              filter: 'audioonly',
              type: 'mp3',
              quality: 'highest',
            },
            filename: `${videoId}.mp3`,
          });
          buffer = Buffer.from(await file.arrayBuffer());
        } catch (classError) {
          console.warn('YtDlp class method failed, falling back to command:', classError.message);
          // Fallback to our command-line extraction method
          buffer = await extractAudio(videoId);
        }
        
        // Cache the result
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
      res.status(500).send('Failed to load audio: ' + err.message);
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