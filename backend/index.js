import express from 'express';
import cors from 'cors';
import youtubedl from 'youtube-dl-exec';
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

// The bin directory will be managed by youtube-dl-exec
const BIN_DIR = path.join(process.cwd(), 'bin');
const cookiesPath = path.join(os.tmpdir(), 'youtube_cookies.txt');

// Create a directory for temporary files
const tmpDir = path.join(os.tmpdir(), 'yt-download');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// Create yt-dlp config with increased rate limit and additional options
const configDir = path.join(os.tmpdir(), 'yt-dlp-config');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Create a yt-dlp config file with additional options
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

// Helper function to extract audio using youtube-dl-exec with multiple strategies
async function extractAudio(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(tmpDir, `${videoId}.mp3`);
  
  const commonOptions = {
    output: outputPath,
    extractAudio: true,
    audioFormat: 'mp3',
    audioQuality: 0,
    configLocation: configPath
  };
  
  // If cookies file exists, add it to options
  if (fs.existsSync(cookiesPath)) {
    commonOptions.cookies = cookiesPath;
  }

  // Strategy 1: Try with standard options
  try {
    console.log(`Extracting audio for ${url} (Strategy 1)`);
    await youtubedl(url, {
      ...commonOptions
    });
    
    if (fs.existsSync(outputPath)) {
      const buffer = await fs.promises.readFile(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    }
  } catch (err) {
    console.warn('Strategy 1 failed:', err.message);
  }

  // Strategy 2: Try with additional bypass options
  try {
    console.log(`Extracting audio for ${url} (Strategy 2)`);
    await youtubedl(url, {
      ...commonOptions,
      addHeader: [
        'Referer:https://www.youtube.com/',
        'Origin:https://www.youtube.com'
      ],
      sleepInterval: 1,
      maxSleepInterval: 5
    });
    
    if (fs.existsSync(outputPath)) {
      const buffer = await fs.promises.readFile(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    }
  } catch (err) {
    console.warn('Strategy 2 failed:', err.message);
  }

  // Strategy 3: Try with a direct format selection
  try {
    // First list available formats
    console.log(`Listing formats for ${url}`);
    const formatInfo = await youtubedl(url, {
      listFormats: true,
      cookies: cookiesPath
    });
    
    console.log('Available formats:\n' + formatInfo);
    
    // Extract a good audio format ID (usually m4a or webm)
    const formatMatch = formatInfo.match(/(\d+)\s+audio only.*?(m4a|webm)/i);
    if (formatMatch && formatMatch[1]) {
      const formatId = formatMatch[1];
      
      console.log(`Extracting audio for ${url} (Strategy 3 with format ${formatId})`);
      await youtubedl(url, {
        ...commonOptions,
        format: formatId,
        recodeVideo: 'mp3'
      });
      
      if (fs.existsSync(outputPath)) {
        const buffer = await fs.promises.readFile(outputPath);
        fs.unlinkSync(outputPath);
        return buffer;
      }
    }
  } catch (err) {
    console.warn('Strategy 3 failed:', err.message);
  }

  // Strategy 4: Try with cookies from browser
  try {
    console.log(`Extracting audio for ${url} (Strategy 4)`);
    await youtubedl(url, {
      ...commonOptions,
      cookiesFromBrowser: 'chrome'
    });
    
    if (fs.existsSync(outputPath)) {
      const buffer = await fs.promises.readFile(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    }
  } catch (err) {
    console.warn('Strategy 4 failed:', err.message);
  }

  throw new Error('All extraction strategies failed');
}

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
          // Extract audio using youtube-dl-exec
          buffer = await extractAudio(videoId);
        } catch (error) {
          console.error('Audio extraction failed:', error.message);
          return res.status(500).send('Failed to extract audio: ' + error.message);
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
      const result = await youtubedl.exec(testUrl, {
        skipDownload: true,
        cookies: cookiesPath,
        f: true // List formats
      });
      
      res.json({ 
        status: 'ok', 
        message: 'YouTube API is accessible',
        formats: result.stdout.split('\n').length - 1
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

// Start the server immediately since youtube-dl-exec handles binary installation
startServer();