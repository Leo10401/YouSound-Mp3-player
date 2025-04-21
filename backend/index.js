import express from 'express';
import cors from 'cors';
import NodeCache from 'node-cache';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import rateLimit from 'express-rate-limit';
import https from 'https';

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

// Directory and file paths
const BIN_DIR = path.join(process.cwd(), 'bin');
const cookiesPath = path.join(os.tmpdir(), 'youtube_cookies.txt');
const tmpDir = path.join(os.tmpdir(), 'yt-download');
const configDir = path.join(os.tmpdir(), 'yt-dlp-config');
const configPath = path.join(configDir, 'config');

// Binary paths
const ytdlpPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const ytdlPath = path.join(BIN_DIR, process.platform === 'win32' ? 'youtube-dl.exe' : 'youtube-dl');

// Create required directories
for (const dir of [BIN_DIR, tmpDir, configDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
}

// Create a yt-dlp config file with additional options
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
console.log(`Created config file at: ${configPath}`);

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

/**
 * Downloads the yt-dlp binary with proper error handling
 */
async function downloadYtDlp() {
  console.log('Starting yt-dlp download...');
  
  try {
    // Create bin directory if it doesn't exist
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
      console.log(`Created bin directory at ${BIN_DIR}`);
    }
    
    // Remove existing binary if it exists (to ensure a clean download)
    if (fs.existsSync(ytdlpPath)) {
      fs.unlinkSync(ytdlpPath);
      console.log(`Removed existing binary at ${ytdlpPath}`);
    }
    
    // Try multiple download approaches
    
    // Approach 1: Use curl (most reliable)
    try {
      console.log('Downloading yt-dlp using curl...');
      const url = process.platform === 'win32' 
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
      
      await execPromise(`curl -L "${url}" -o "${ytdlpPath}"`);
      fs.chmodSync(ytdlpPath, 0o755);
      console.log(`Successfully downloaded yt-dlp using curl to ${ytdlpPath}`);
      return true;
    } catch (err) {
      console.warn('curl download failed:', err.message);
    }
    
    // Approach 2: Use HTTPS module
    try {
      console.log('Downloading yt-dlp using https module...');
      const url = process.platform === 'win32' 
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
      
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(ytdlpPath);
        https.get(url, response => {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            fs.chmodSync(ytdlpPath, 0o755);
            console.log(`Downloaded yt-dlp using https to ${ytdlpPath}`);
            resolve();
          });
        }).on('error', err => {
          if (fs.existsSync(ytdlpPath)) fs.unlinkSync(ytdlpPath);
          reject(err);
        });
      });
      return true;
    } catch (err) {
      console.warn('https download failed:', err.message);
    }
    
    // Approach 3: Try using wget
    try {
      console.log('Downloading yt-dlp using wget...');
      const url = process.platform === 'win32' 
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
      
      await execPromise(`wget "${url}" -O "${ytdlpPath}"`);
      fs.chmodSync(ytdlpPath, 0o755);
      console.log(`Successfully downloaded yt-dlp using wget to ${ytdlpPath}`);
      return true;
    } catch (err) {
      console.warn('wget download failed:', err.message);
    }
    
    console.error('All download approaches failed!');
    return false;
  } catch (error) {
    console.error('Failed to download yt-dlp:', error);
    return false;
  }
}

/**
 * Verifies that the yt-dlp binary exists and is executable
 */
async function verifyYtDlpBinary() {
  console.log('Verifying yt-dlp binary...');
  
  try {
    // Check if binary exists
    if (!fs.existsSync(ytdlpPath)) {
      console.log(`Binary not found at ${ytdlpPath}, will download`);
      return false;
    }
    
    // Make it executable
    fs.chmodSync(ytdlpPath, 0o755);
    
    // Test if it works
    const { stdout } = await execPromise(`"${ytdlpPath}" --version`);
    console.log(`yt-dlp binary verified, version: ${stdout.trim()}`);
    return true;
  } catch (error) {
    console.error('yt-dlp binary verification failed:', error.message);
    return false;
  }
}

/**
 * Ensures the yt-dlp binary is available and working
 */
async function ensureYtDlpBinary() {
  let verified = await verifyYtDlpBinary();
  
  if (!verified) {
    console.log('Binary verification failed, downloading fresh copy...');
    await downloadYtDlp();
    verified = await verifyYtDlpBinary();
  }
  
  if (!verified) {
    console.error('Failed to ensure a working yt-dlp binary after multiple attempts');
    return false;
  }
  
  console.log('yt-dlp binary is ready to use');
  return true;
}

/**
 * Extract audio from a YouTube video with multiple fallback strategies
 */
async function extractAudio(videoId) {
  console.log(`Starting audio extraction for video ID: ${videoId}`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(tmpDir, `${videoId}.mp3`);
  
  // Clean up any existing output file
  if (fs.existsSync(outputPath)) {
    try {
      fs.unlinkSync(outputPath);
      console.log(`Removed existing output file: ${outputPath}`);
    } catch (err) {
      console.warn(`Failed to remove existing output file: ${err.message}`);
    }
  }
  
  // Make sure binary is ready
  if (!fs.existsSync(ytdlpPath)) {
    console.log('Binary not found, downloading...');
    await downloadYtDlp();
  }
  
  // Ensure the binary is executable
  try {
    fs.chmodSync(ytdlpPath, 0o755);
  } catch (err) {
    console.warn(`Failed to set executable permissions: ${err.message}`);
  }
  
  // Define common options for all strategies
  const commonOptions = {
    '--output': outputPath,
    '--extract-audio': true,
    '--audio-format': 'mp3',
    '--audio-quality': '0',
    '--geo-bypass': true,
    '--no-check-certificate': true
  };
  
  // If cookies file exists, add it to options
  if (fs.existsSync(cookiesPath)) {
    commonOptions['--cookies'] = cookiesPath;
  }
  
  // Strategy 1: Direct shell command execution (most reliable)
  try {
    console.log(`Strategy 1: Direct shell command for ${url}`);
    
    // Build command with all options
    let command = `"${ytdlpPath}" "${url}"`;
    for (const [key, value] of Object.entries(commonOptions)) {
      if (value === true) {
        command += ` ${key}`;
      } else {  
        command += ` ${key} "${value}"`;
      }
    }
    
    console.log(`Executing command: ${command}`);
    
    const { stdout, stderr } = await execPromise(command, { maxBuffer: 10 * 1024 * 1024 });
    
    if (stderr) console.log(`Command stderr: ${stderr}`);
    if (stdout) console.log(`Command stdout: ${stdout.substring(0, 200)}...`);
    
    if (fs.existsSync(outputPath)) {
      console.log(`Strategy 1 succeeded. File size: ${fs.statSync(outputPath).size} bytes`);
      const buffer = fs.readFileSync(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      console.warn('Strategy 1: Output file not found');
    }
  } catch (err) {
    console.warn(`Strategy 1 failed: ${err.message}`);
  }
  
  // Strategy 2: Simplified command with basic options
  try {
    console.log(`Strategy 2: Simplified command for ${url}`);
    
    const command = `"${ytdlpPath}" "${url}" -x --audio-format mp3 -o "${outputPath}" --geo-bypass`;
    console.log(`Executing command: ${command}`);
    
    const { stdout, stderr } = await execPromise(command);
    
    if (stderr) console.log(`Strategy 2 stderr: ${stderr}`);
    if (stdout) console.log(`Strategy 2 stdout: ${stdout.substring(0, 200)}...`);
    
    if (fs.existsSync(outputPath)) {
      console.log(`Strategy 2 succeeded. File size: ${fs.statSync(outputPath).size} bytes`);
      const buffer = fs.readFileSync(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      console.warn('Strategy 2: Output file not found');
    }
  } catch (err) {
    console.warn(`Strategy 2 failed: ${err.message}`);
  }
  
  // Strategy 3: Try using format selection
  try {
    console.log(`Strategy 3: Format selection for ${url}`);
    
    const command = `"${ytdlpPath}" "${url}" -f bestaudio -x --audio-format mp3 -o "${outputPath}"`;
    console.log(`Executing command: ${command}`);
    
    const { stdout, stderr } = await execPromise(command);
    
    if (stderr) console.log(`Strategy 3 stderr: ${stderr}`);
    if (stdout) console.log(`Strategy 3 stdout: ${stdout.substring(0, 200)}...`);
    
    if (fs.existsSync(outputPath)) {
      console.log(`Strategy 3 succeeded. File size: ${fs.statSync(outputPath).size} bytes`);
      const buffer = fs.readFileSync(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      console.warn('Strategy 3: Output file not found');
    }
  } catch (err) {
    console.warn(`Strategy 3 failed: ${err.message}`);
  }
  
  // Strategy 4: Use ffmpeg directly if possible
  try {
    console.log(`Strategy 4: FFmpeg approach for ${url}`);
    
    // First get the best audio URL
    const getUrlCommand = `"${ytdlpPath}" "${url}" -f bestaudio --get-url`;
    console.log(`Getting audio URL: ${getUrlCommand}`);
    
    const { stdout: audioUrl } = await execPromise(getUrlCommand);
    const directUrl = audioUrl.trim();
    
    if (!directUrl) {
      throw new Error('Failed to get direct audio URL');
    }
    
    console.log(`Got direct audio URL: ${directUrl.substring(0, 30)}...`);
    
    // Download with curl or wget
    const tempFile = path.join(tmpDir, `${videoId}_temp`);
    try {
      await execPromise(`curl -L "${directUrl}" -o "${tempFile}"`);
    } catch (err) {
      await execPromise(`wget "${directUrl}" -O "${tempFile}"`);
    }
    
    // Convert with ffmpeg
    await execPromise(`ffmpeg -i "${tempFile}" -vn -ar 44100 -ac 2 -b:a 192k "${outputPath}"`);
    
    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    
    if (fs.existsSync(outputPath)) {
      console.log(`Strategy 4 succeeded. File size: ${fs.statSync(outputPath).size} bytes`);
      const buffer = fs.readFileSync(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      console.warn('Strategy 4: Output file not found');
    }
  } catch (err) {
    console.warn(`Strategy 4 failed: ${err.message}`);
  }
  
  // If we get here, all strategies failed
  throw new Error('All extraction strategies failed. Could not download audio from YouTube.');
}

/**
 * Start the server and define routes
 */
async function startServer() {
  // Ensure yt-dlp binary is available
  const binaryReady = await ensureYtDlpBinary();
  if (!binaryReady) {
    console.warn('Warning: yt-dlp binary is not available. Audio extraction may fail.');
  }
  
  // Audio endpoint to stream audio files
  app.get('/audio/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const cacheKey = `audio-${videoId}`;
    
    try {
      let buffer = audioCache.get(cacheKey);

      if (!buffer) {
        console.log(`Fetching audio for video ID: ${videoId}`);
        try {
          // Extract audio
          buffer = await extractAudio(videoId);
          
          // Verify the buffer is valid MP3 data
          if (!buffer || buffer.length < 1000) {
            throw new Error('Extracted audio file is too small or empty');
          }
          
          // Cache the result
          audioCache.set(cacheKey, buffer);
        } catch (error) {
          console.error('Audio extraction failed:', error.message);
          return res.status(500).send('Failed to extract audio: ' + error.message);
        }
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
      // Try to get version info
      const { stdout } = await execPromise(`"${ytdlpPath}" --version`);
      
      res.json({ 
        status: 'ok', 
        binary: {
          path: ytdlpPath,
          exists: fs.existsSync(ytdlpPath),
          version: stdout.trim()
        },
        environment: {
          platform: process.platform,
          nodejs: process.version
        }
      });
    } catch (err) {
      res.status(500).json({ 
        status: 'error',
        message: 'Failed to execute yt-dlp',
        error: err.message,
        binaryPath: ytdlpPath,
        binaryExists: fs.existsSync(ytdlpPath)
      });
    }
  });

  // Debug endpoint to get detailed information about the binary
  app.get('/debug', async (req, res) => {
    try {
      // List bin directory contents
      const binFiles = fs.existsSync(BIN_DIR) ? fs.readdirSync(BIN_DIR) : [];
      
      // Get binary info
      let versionInfo = "Unknown";
      let binaryWorks = false;
      try {
        const { stdout } = await execPromise(`"${ytdlpPath}" --version`);
        versionInfo = stdout.trim();
        binaryWorks = true;
      } catch (e) {
        versionInfo = `Error: ${e.message}`;
      }
      
      // Get environment info
      const envInfo = {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ? process.env.PATH.split(':') : [],
        PLATFORM: process.platform,
        ARCH: process.arch,
        NODE_VERSION: process.version
      };
      
      // Test download
      let downloadTest = "Not tested";
      try {
        const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Common test video
        const command = `"${ytdlpPath}" "${testUrl}" --get-title`;
        const { stdout } = await execPromise(command);
        downloadTest = `Success: "${stdout.trim()}"`;
      } catch (e) {
        downloadTest = `Failed: ${e.message}`;
      }
      
      // Get binary permissions
      let permissions = "Unknown";
      try {
        const stats = fs.statSync(ytdlpPath);
        permissions = `0${(stats.mode & parseInt('777', 8)).toString(8)}`;
      } catch (e) {
        permissions = `Error: ${e.message}`;
      }
      
      res.json({
        binDir: {
          path: BIN_DIR,
          exists: fs.existsSync(BIN_DIR),
          files: binFiles
        },
        ytdlpBinary: {
          path: ytdlpPath,
          exists: fs.existsSync(ytdlpPath),
          permissions: permissions,
          version: versionInfo,
          works: binaryWorks,
          downloadTest: downloadTest
        },
        environment: envInfo,
        storage: {
          tmpDir: {
            path: tmpDir,
            exists: fs.existsSync(tmpDir)
          },
          configDir: {
            path: configDir,
            exists: fs.existsSync(configDir)
          },
          cookiesFile: {
            path: cookiesPath,
            exists: fs.existsSync(cookiesPath)
          }
        }
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        message: 'Error getting debug info',
        error: err.message
      });
    }
  });
  
  // Test command execution endpoint
  app.get('/test-command', async (req, res) => {
    try {
      // Try to run a simple command
      const commands = [
        {name: 'ls', cmd: 'ls -la /opt/render/project/src/'},
        {name: 'echo', cmd: 'echo "Hello World"'},
        {name: 'pwd', cmd: 'pwd'},
        {name: 'yt-dlp', cmd: `"${ytdlpPath}" --version`}
      ];
      
      const results = {};
      
      for (const cmd of commands) {
        try {
          const { stdout, stderr } = await execPromise(cmd.cmd);
          results[cmd.name] = {
            success: true,
            stdout: stdout.trim(),
            stderr: stderr ? stderr.trim() : ''
          };
        } catch (e) {
          results[cmd.name] = {
            success: false,
            error: e.message
          };
        }
      }
      
      res.json({
        environment: {
          uid: process.getuid?.() || 'unknown',
          gid: process.getgid?.() || 'unknown',
          cwd: process.cwd()
        },
        results
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        message: 'Command execution failed',
        error: err.message
      });
    }
  });
  
  // Simple health check endpoint
  app.get('/health', (_, res) => {
    res.status(200).send('OK');
  });
  
  // Initiate download - admin endpoint
  app.get('/admin/download-yt-dlp', async (req, res) => {
    try {
      const result = await downloadYtDlp();
      res.json({
        success: result,
        message: result ? 'yt-dlp binary downloaded successfully' : 'Download failed',
        path: ytdlpPath,
        exists: fs.existsSync(ytdlpPath)
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        message: 'Failed to download binary',
        error: err.message
      });
    }
  });

  // Start the server
  app.listen(PORT, () => {
    console.log(`🎧 Audio server running on port ${PORT}`);
  });
}

// Start the server with error handling
(async () => {
  try {
    await startServer();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();