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

// Helper function to download yt-dlp binary directly
async function downloadYtDlp() {
  const targetPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const url = process.platform === 'win32' 
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    
  console.log(`Downloading yt-dlp from ${url} to ${targetPath}`);
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(path.dirname(targetPath))) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }
  
  try {
    const file = fs.createWriteStream(targetPath);
    
    await new Promise((resolve, reject) => {
      https.get(url, response => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.chmodSync(targetPath, 0o755); // Make executable
          console.log(`Downloaded yt-dlp to ${targetPath}`);
          resolve();
        });
      }).on('error', err => {
        fs.unlinkSync(targetPath);
        reject(err);
      });
    });
    
    return true;
  } catch (error) {
    console.error('Failed to download yt-dlp:', error);
    return false;
  }
}

// Function to ensure yt-dlp binary is available
async function ensureYtDlpBinary() {
  try {
    // Check if bin directory exists
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
      console.log(`Created bin directory at ${BIN_DIR}`);
    }
    
    // Try to use youtube-dl-exec's binary
    try {
      await youtubedl.exec('--version', {});
      console.log('yt-dlp binary is available via youtube-dl-exec');
      
      // Try to get the binary path
      let binPath;
      try {
        // This is not a standard function but works if available
        if (typeof youtubedl.getBinaryPath === 'function') {
          binPath = youtubedl.getBinaryPath();
          console.log(`yt-dlp binary path from youtube-dl-exec: ${binPath}`);
        }
      } catch (e) {
        console.log('Could not get binary path from youtube-dl-exec:', e.message);
      }
      
      // If running on Render, try to copy from node_modules
      if (process.env.RENDER || process.env.IS_RENDER) {
        const nodeBinPath = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin');
        if (fs.existsSync(nodeBinPath)) {
          const files = fs.readdirSync(nodeBinPath);
          console.log(`Found in node_modules bin: ${files.join(', ')}`);
          
          // Copy the binary to our bin directory
          for (const file of files) {
            if (file.includes('yt-dlp')) {
              const source = path.join(nodeBinPath, file);
              const target = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
              fs.copyFileSync(source, target);
              fs.chmodSync(target, 0o755); // Make executable
              console.log(`Copied ${file} to ${target}`);
            }
          }
        }
      }
    } catch (error) {
      console.warn('youtube-dl-exec binary check failed:', error.message);
      console.log('Attempting direct download as fallback...');
      await downloadYtDlp();
    }
    
    // Verify the binary exists in our bin directory
    const expectedPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (!fs.existsSync(expectedPath)) {
      console.log(`Binary not found at ${expectedPath}, attempting direct download`);
      await downloadYtDlp();
    } else {
      console.log(`Binary found at ${expectedPath}`);
      // Ensure it's executable
      fs.chmodSync(expectedPath, 0o755);
    }
    
    // Final verification test
    try {
      const { stdout } = await execPromise(`"${expectedPath}" --version`);
      console.log(`yt-dlp version: ${stdout.trim()}`);
      return true;
    } catch (e) {
      console.error(`Binary verification failed: ${e.message}`);
      return false;
    }
  } catch (error) {
    console.error('Failed to ensure yt-dlp binary:', error);
    return false;
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
  
  // Find all possible yt-dlp binary paths
  const possiblePaths = [
    path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
    path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp' // Let the system try to find it in PATH
  ];
  
  // Log all possible paths for debugging
  console.log('Possible yt-dlp paths:', possiblePaths);
  
  let ytdlpPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      ytdlpPath = p;
      console.log(`Found yt-dlp at: ${ytdlpPath}`);
      break;
    }
  }
  
  if (!ytdlpPath) {
    console.log('No yt-dlp binary found in expected locations. Will try to use youtube-dl-exec default.');
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

  // Strategy 3: Use raw command with the found binary path
  try {
    // Use the binary path we found earlier
    const executablePath = ytdlpPath || path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    console.log(`Using raw command with binary at: ${executablePath}`);

    // Execute with raw command for more control
    const command = `"${executablePath}" "${url}" -x --audio-format mp3 --audio-quality 0 -o "${outputPath}" --geo-bypass --no-check-certificate --verbose`;
    
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
    
    // Check if youtube-dl exists or try to download it
    const ytdlPath = path.join(BIN_DIR, process.platform === 'win32' ? 'youtube-dl.exe' : 'youtube-dl');
    if (!fs.existsSync(ytdlPath)) {
      const ytdlUrl = process.platform === 'win32' 
        ? 'https://yt-dl.org/downloads/latest/youtube-dl.exe'
        : 'https://yt-dl.org/downloads/latest/youtube-dl';
        
      console.log(`Downloading youtube-dl from ${ytdlUrl}`);
      const file = fs.createWriteStream(ytdlPath);
      
      await new Promise((resolve, reject) => {
        https.get(ytdlUrl, response => {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            fs.chmodSync(ytdlPath, 0o755); // Make executable
            resolve();
          });
        }).on('error', err => {
          fs.unlinkSync(ytdlPath);
          reject(err);
        });
      });
    }
    
    // Try using youtube-dl directly
    const command = `"${ytdlPath}" "${url}" -x --audio-format mp3 --audio-quality 0 -o "${outputPath}" --no-check-certificate`;
    const { stdout, stderr } = await execPromise(command);
    
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

  // Strategy 5: Try simple curl and ffmpeg approach as last resort
  try {
    console.log(`Trying curl+ffmpeg approach for ${url} (Strategy 5)`);
    
    // First get direct URL using youtube-dl --get-url
    const tempScriptPath = path.join(tmpDir, `get_url_${videoId}.sh`);
    const getBinaryCmd = ytdlpPath || 'yt-dlp';
    
    // Write a small script to get the URL
    fs.writeFileSync(tempScriptPath, `#!/bin/bash
${getBinaryCmd} -f 'bestaudio' --get-url "${url}"
`);
    fs.chmodSync(tempScriptPath, 0o755);
    
    // Execute the script
    const { stdout: directUrl } = await execPromise(`bash ${tempScriptPath}`);
    const audioUrl = directUrl.trim();
    
    if (!audioUrl) {
      throw new Error('Failed to get direct audio URL');
    }
    
    console.log(`Got direct audio URL: ${audioUrl.substring(0, 30)}...`);
    
    // Now use curl to download the file
    const curlTempPath = path.join(tmpDir, `${videoId}_temp.webm`);
    await execPromise(`curl -L -o "${curlTempPath}" "${audioUrl}"`);
    
    // Convert to mp3 if needed
    await execPromise(`ffmpeg -i "${curlTempPath}" -vn -ar 44100 -ac 2 -b:a 192k "${outputPath}"`);
    
    // Clean up temp file
    if (fs.existsSync(curlTempPath)) {
      fs.unlinkSync(curlTempPath);
    }
    
    if (fs.existsSync(outputPath)) {
      const buffer = await fs.promises.readFile(outputPath);
      fs.unlinkSync(outputPath);
      return buffer;
    } else {
      console.warn("Output file not found after strategy 5");
    }
  } catch (err) {
    console.warn('Strategy 5 failed:', err.message);
  }

  throw new Error('All extraction strategies failed. Could not download audio from YouTube.');
}

// Define routes and start server
async function startServer() {
  // Ensure the yt-dlp binary is available before starting
  await ensureYtDlpBinary();

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

// Start the server with async/await
(async () => {
  try {
    await startServer();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();