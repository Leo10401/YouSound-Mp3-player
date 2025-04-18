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
import rateLimit from 'express-rate-limit';

dotenv.config();
const execPromise = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;
const audioCache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

// Rate limiter to avoid excessive YouTube requests
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // limit each IP to 30 requests per windowMs
  message: 'Too many requests, please try again later'
});

app.use(cors());
app.use('/audio', apiLimiter);

// First, ensure binary directory exists
if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

// Path for yt-dlp binary
const ytdlpPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const cookiesPath = path.join(os.tmpdir(), 'youtube_cookies.txt');

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

// Load YouTube cookies from environment variable if available
if (process.env.YOUTUBE_COOKIES_BASE64) {
  try {
    const cookiesContent = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString();
    fs.writeFileSync(cookiesPath, cookiesContent);
    console.log('YouTube cookies file created from environment variable');
  } catch (error) {
    console.error('Failed to create cookies file from environment variable:', error);
  }
}

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

// Helper function to extract audio using raw command with multiple strategies
async function extractAudio(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const tempOutput = path.join(os.tmpdir(), `${videoId}.%(ext)s`);
  const finalPath = path.join(os.tmpdir(), `${videoId}.mp3`);

  // Strategy 1: Try with standard options
  try {
    const command = `"${ytdlpPath}" "${url}" \
      --cookies "${cookiesPath}" \
      --config-location "${configPath}" \
      -x --audio-format mp3 --audio-quality 0 \
      -o "${tempOutput}"`;

    console.log(`Running yt-dlp command (Strategy 1):\n${command}\n`);
    const { stdout, stderr } = await execPromise(command);
    console.log(stdout);
    if (stderr) console.warn(stderr);
    
    if (fs.existsSync(finalPath)) {
      const buffer = await fs.promises.readFile(finalPath);
      fs.unlinkSync(finalPath);
      return buffer;
    }
  } catch (err) {
    console.warn('Strategy 1 failed:', err.message);
  }

  // Strategy 2: Try with additional bypass options
  try {
    const command = `"${ytdlpPath}" "${url}" \
      --cookies "${cookiesPath}" \
      --config-location "${configPath}" \
      --add-header "Referer:https://www.youtube.com/" \
      --add-header "Origin:https://www.youtube.com" \
      --sleep-interval 1 --max-sleep-interval 5 \
      -x --audio-format mp3 --audio-quality 0 \
      -o "${tempOutput}"`;

    console.log(`Running yt-dlp command (Strategy 2):\n${command}\n`);
    const { stdout, stderr } = await execPromise(command);
    console.log(stdout);
    if (stderr) console.warn(stderr);
    
    if (fs.existsSync(finalPath)) {
      const buffer = await fs.promises.readFile(finalPath);
      fs.unlinkSync(finalPath);
      return buffer;
    }
  } catch (err) {
    console.warn('Strategy 2 failed:', err.message);
  }

  // Strategy 3: Try with a direct format selection
  try {
    // First list available formats
    const formatListCmd = `"${ytdlpPath}" -F "${url}" --cookies "${cookiesPath}"`;
    console.log(`Listing formats:\n${formatListCmd}\n`);
    const { stdout } = await execPromise(formatListCmd);
    console.log('Available formats:\n' + stdout);
    
    // Extract a good audio format ID (usually m4a or webm)
    const formatMatch = stdout.match(/(\d+)\s+audio only.*?(m4a|webm)/i);
    if (formatMatch && formatMatch[1]) {
      const formatId = formatMatch[1];
      
      const command = `"${ytdlpPath}" "${url}" \
        --cookies "${cookiesPath}" \
        --config-location "${configPath}" \
        -f ${formatId} \
        --recode-video mp3 \
        -o "${tempOutput}"`;

      console.log(`Running yt-dlp command (Strategy 3 with format ${formatId}):\n${command}\n`);
      const { stdout, stderr } = await execPromise(command);
      console.log(stdout);
      if (stderr) console.warn(stderr);
      
      if (fs.existsSync(finalPath)) {
        const buffer = await fs.promises.readFile(finalPath);
        fs.unlinkSync(finalPath);
        return buffer;
      }
    }
  } catch (err) {
    console.warn('Strategy 3 failed:', err.message);
  }

  // Strategy 4: Try with cookies from browser
  try {
    const command = `"${ytdlpPath}" "${url}" \
      --cookies-from-browser chrome \
      --config-location "${configPath}" \
      -x --audio-format mp3 --audio-quality 0 \
      -o "${tempOutput}"`;

    console.log(`Running yt-dlp command (Strategy 4):\n${command}\n`);
    const { stdout, stderr } = await execPromise(command);
    console.log(stdout);
    if (stderr) console.warn(stderr);
    
    if (fs.existsSync(finalPath)) {
      const buffer = await fs.promises.readFile(finalPath);
      fs.unlinkSync(finalPath);
      return buffer;
    }
  } catch (err) {
    console.warn('Strategy 4 failed:', err.message);
  }

  throw new Error('All extraction strategies failed');
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
  // Audio endpoint to stream audio files
  app.get('/audio/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const cacheKey = `audio-${videoId}`;
    
    try {
      let buffer = audioCache.get(cacheKey);

      if (!buffer) {
        console.log(`Fetching audio for video ID: ${videoId}`);
        try {
          // First try with the YtDlp class
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
          // Fallback to our multi-strategy extraction method
          buffer = await extractAudio(videoId);
        }
        
        // Cache the result
        audioCache.set(cacheKey, buffer);
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

  // Status endpoint to check if YouTube cookies are working
  app.get('/status', async (req, res) => {
    try {
      const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // A popular video
      const command = `"${ytdlpPath}" -F "${testUrl}" --cookies "${cookiesPath}" --skip-download`;
      const { stdout } = await execPromise(command);
      res.json({ 
        status: 'ok', 
        message: 'YouTube API is accessible',
        formats: stdout.split('\n').length - 1
      });
    } catch (err) {
      res.status(500).json({ 
        status: 'error', 
        message: 'YouTube API is not accessible',
        error: err.message 
      });
    }
  });

  // Cookie validation endpoint to check/update cookies
  app.get('/validate-cookies', async (req, res) => {
    if (!fs.existsSync(cookiesPath)) {
      return res.status(404).json({
        status: 'error',
        message: 'No cookies file found'
      });
    }
    
    try {
      const stats = fs.statSync(cookiesPath);
      const fileSize = stats.size;
      const lastModified = stats.mtime;
      
      res.json({
        status: 'ok',
        cookiesPath: cookiesPath,
        fileSize: `${fileSize} bytes`,
        lastModified: lastModified,
        message: 'Cookies file exists'
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        message: 'Error accessing cookies file',
        error: err.message
      });
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