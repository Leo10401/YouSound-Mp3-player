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

// Fix for the X-Forwarded-For header issue - Enable trust proxy
app.set('trust proxy', 1);

// Rate limiter to avoid excessive YouTube requests
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // limit each IP to 30 requests per windowMs
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false
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

// Helper function to extract audio using youtube-dl-exec with better error handling
async function extractAudio(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(tmpDir, `${videoId}.mp3`);
  
  // Make sure temporary directory exists
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  // Clear any previous output file if it exists
  if (fs.existsSync(outputPath)) {
    try {
      fs.unlinkSync(outputPath);
    } catch (err) {
      console.warn(`Failed to remove existing output file: ${err.message}`);
    }
  }
  
  const commonOptions = {
    output: outputPath,
    extractAudio: true,
    audioFormat: 'mp3',
    audioQuality: 0,
    verbose: true // Add verbose output for debugging
  };
  
  // If cookies file exists, add it to options
  if (fs.existsSync(cookiesPath)) {
    commonOptions.cookies = cookiesPath;
  }

  // Strategy 1: Direct download with verbose output
  try {
    console.log(`Extracting audio for ${url} (Strategy 1)`);
    const { stdout, stderr } = await youtubedl.exec(url, {
      ...commonOptions,
      noCheckCertificates: true,
      preferFreeFormats: true,
      noWarnings: true,
      addHeader: ['referer:youtube.com', 'user-agent:googlebot']
    });
    
    console.log("Strategy 1 stdout:", stdout);
    if (stderr) console.warn("Strategy 1 stderr:", stderr);
    
    if (fs.existsSync(outputPath)) {
      const buffer = await fs.promises.readFile(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      console.warn("Output file not found after strategy 1");
    }
  } catch (err) {
    console.warn('Strategy 1 failed:', err.message);
  }

  // Strategy 2: Format-specific download
  try {
    console.log(`Extracting audio for ${url} (Strategy 2)`);
    
    // Use direct format specification for better compatibility
    const { stdout, stderr } = await youtubedl.exec(url, {
      output: outputPath,
      format: 'bestaudio[ext=m4a]/bestaudio',
      extractAudio: true,
      audioFormat: 'mp3',
      geoBypass: true,
      noCheckCertificates: true,
      addHeader: [
        'Referer:https://www.youtube.com/',
        'Origin:https://www.youtube.com'
      ]
    });
    
    console.log("Strategy 2 stdout:", stdout);
    if (stderr) console.warn("Strategy 2 stderr:", stderr);
    
    if (fs.existsSync(outputPath)) {
      const buffer = await fs.promises.readFile(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      console.warn("Output file not found after strategy 2");
    }
  } catch (err) {
    console.warn('Strategy 2 failed:', err.message);
  }

  // Strategy 3: Use raw command for maximum control
  try {
    const ytdlpPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    console.log(`Using raw command with binary at: ${ytdlpPath}`);

    // Execute with raw command for more control
    const command = `"${ytdlpPath}" "${url}" -x --audio-format mp3 --audio-quality 0 -o "${outputPath}" --geo-bypass --no-check-certificates`;
    
    console.log(`Running raw command: ${command}`);
    const { stdout, stderr } = await execPromise(command);
    
    console.log("Strategy 3 stdout:", stdout);
    if (stderr) console.warn("Strategy 3 stderr:", stderr);
    
    if (fs.existsSync(outputPath)) {
      const buffer = await fs.promises.readFile(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      console.warn("Output file not found after strategy 3");
    }
  } catch (err) {
    console.warn('Strategy 3 failed:', err.message);
  }

  // Strategy 4: Attempt download with youtube-dl fallback
  try {
    console.log(`Fallback to youtube-dl command for ${url} (Strategy 4)`);
    
    // Create a fallback instance with youtube-dl
    const { create: createYoutubeDl } = youtubedl;
    const altYoutubeDl = createYoutubeDl(
      path.join(BIN_DIR, process.platform === 'win32' ? 'youtube-dl.exe' : 'youtube-dl')
    );
    
    const { stdout, stderr } = await altYoutubeDl.exec(url, {
      output: outputPath,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      noCheckCertificate: true,
      format: 'bestaudio'
    });
    
    console.log("Strategy 4 stdout:", stdout);
    if (stderr) console.warn("Strategy 4 stderr:", stderr);
    
    if (fs.existsSync(outputPath)) {
      const buffer = await fs.promises.readFile(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      console.warn("Output file not found after strategy 4");
    }
  } catch (err) {
    console.warn('Strategy 4 failed:', err.message);
  }

  throw new Error('All extraction strategies failed. Could not download audio from YouTube.');
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

  // Add a debugging endpoint to check binary paths
  app.get('/debug', async (req, res) => {
    try {
      const binFiles = fs.existsSync(BIN_DIR) ? fs.readdirSync(BIN_DIR) : [];
      const ytdlpPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
      const ytdlpExists = fs.existsSync(ytdlpPath);
      
      // Try to get version info
      let versionInfo = "Unknown";
      try {
        const { stdout } = await execPromise(`"${ytdlpPath}" --version`);
        versionInfo = stdout.trim();
      } catch (e) {
        versionInfo = `Error getting version: ${e.message}`;
      }
      
      res.json({
        platform: process.platform,
        binDir: BIN_DIR,
        binFiles,
        ytdlpPath,
        ytdlpExists,
        ytdlpVersion: versionInfo,
        tmpDir,
        configDir,
        configPath: configPath,
        cookiesPath,
        cookiesExist: fs.existsSync(cookiesPath)
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        message: 'Error getting debug info',
        error: err.message
      });
    }
  });

  app.listen(PORT, () => {
    console.log(`🎧 Audio server running on port ${PORT}`);
  });
}

// Start the server immediately
startServer();