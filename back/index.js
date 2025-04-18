// server.js
const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 4000;

// Create cache directory if it doesn't exist
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
}

// Configure CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Helper to clean old cache files
const cleanCache = () => {
  const files = fs.readdirSync(CACHE_DIR);
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  
  files.forEach(file => {
    const filePath = path.join(CACHE_DIR, file);
    const stats = fs.statSync(filePath);
    
    // If file is older than 24 hours, delete it
    if (now - stats.mtime.getTime() > ONE_DAY) {
      fs.unlinkSync(filePath);
      console.log(`Deleted cached file: ${file}`);
    }
  });
};

// Run cache cleanup every hour
setInterval(cleanCache, 60 * 60 * 1000);

// Health check endpoint
app.get('/', (req, res) => {
  res.send('YouSound Backend API is running');
});

// Helper function to check if youtube-dl is installed
const isYoutubeDlInstalled = () => {
  try {
    execSync('yt-dlp --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    try {
      execSync('youtube-dl --version', { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }
};

// API endpoint to stream audio from YouTube
app.get('/audio/:videoId', async (req, res) => {
  try {
    const videoId = req.params.videoId;
    
    // Input validation
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).send('Invalid video ID');
    }
    
    // Check if file is already cached
    const cacheFilePath = path.join(CACHE_DIR, `${videoId}.mp3`);
    if (fs.existsSync(cacheFilePath)) {
      console.log(`Serving cached audio for video: ${videoId}`);
      
      // Get file details
      const stat = fs.statSync(cacheFilePath);
      
      // Set headers
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Accept-Ranges', 'bytes');
      
      // Handle range requests (for seeking)
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunksize = (end - start) + 1;
        
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', chunksize);
        
        const stream = fs.createReadStream(cacheFilePath, { start, end });
        stream.pipe(res);
      } else {
        // Stream the entire file
        fs.createReadStream(cacheFilePath).pipe(res);
      }
      return;
    }
    
    console.log(`Downloading and converting video: ${videoId}`);
    
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let videoTitle = `youtube_${videoId}`;
    
    // Try to get video info, but have fallback plans
    try {
      const info = await ytdl.getInfo(videoId);
      videoTitle = info.videoDetails.title;
      
      // Process with ytdl-core
      processWithYtdlCore(videoId, videoTitle, cacheFilePath, res);
    } catch (ytdlError) {
      console.error('ytdl-core error:', ytdlError.message);
      
      // Check if youtube-dl or yt-dlp is installed as fallback
      if (isYoutubeDlInstalled()) {
        console.log('Falling back to youtube-dl/yt-dlp');
        processWithYoutubeDl(videoUrl, cacheFilePath, res);
      } else {
        console.error('No fallback available. Both ytdl-core and youtube-dl failed.');
        res.status(500).send('Unable to process video. Try again later.');
      }
    }
  } catch (error) {
    console.error('Error handling audio request:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing your request');
    }
  }
});

// Process video with ytdl-core
function processWithYtdlCore(videoId, videoTitle, cacheFilePath, res) {
  // Set headers for streaming
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(videoTitle)}.mp3"`);
  
  try {
    // Create stream from YouTube
    const audioStream = ytdl(videoId, {
      quality: 'highestaudio',
      filter: 'audioonly',
    });
    
    // Create temporary file path
    const tempFile = `${cacheFilePath}.temp`;
    
    // Set up ffmpeg conversion to mp3
    const ffmpegProcess = ffmpeg(audioStream)
      .audioBitrate(128)
      .format('mp3')
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        if (!res.headersSent) {
          res.status(500).send('Error converting video');
        }
        // Clean up temp file if it exists
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      })
      .on('end', () => {
        console.log('FFmpeg processing finished');
        // Rename temp file to final cached file
        if (fs.existsSync(tempFile)) {
          fs.renameSync(tempFile, cacheFilePath);
        }
      });
    
    // Create write stream for cache
    const cacheStream = fs.createWriteStream(tempFile);
    
    // Send audio to both response and cache file
    const passthrough = new require('stream').PassThrough();
    ffmpegProcess.output(passthrough).output(cacheStream).run();
    passthrough.pipe(res);
  } catch (error) {
    console.error('Error in ytdl-core processing:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing video with ytdl-core');
    }
  }
}

// Process video with youtube-dl or yt-dlp as fallback
function processWithYoutubeDl(videoUrl, cacheFilePath, res) {
  // Set headers for streaming
  res.setHeader('Content-Type', 'audio/mpeg');
  
  const tempFile = `${cacheFilePath}.temp`;
  
  // Determine which tool is available (prefer yt-dlp as it's more updated)
  const tool = (() => {
    try {
      execSync('yt-dlp --version', { stdio: 'ignore' });
      return 'yt-dlp';
    } catch (e) {
      return 'youtube-dl';
    }
  })();
  
  const command = tool === 'yt-dlp' 
    ? `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality 128k -o "${tempFile}" ${videoUrl}`
    : `youtube-dl -f bestaudio --extract-audio --audio-format mp3 --audio-quality 128k -o "${tempFile}" ${videoUrl}`;
  
  const { spawn } = require('child_process');
  const process = spawn('cmd', ['/c', command], { shell: true });
  
  process.stderr.on('data', (data) => {
    console.log(`${tool} stderr: ${data}`);
  });
  
  process.on('close', (code) => {
    if (code === 0) {
      console.log(`${tool} finished successfully`);
      
      // Rename the file (youtube-dl adds .mp3 extension automatically)
      const actualTempFile = `${tempFile}.mp3`;
      
      if (fs.existsSync(actualTempFile)) {
        // Move the file to cache
        fs.renameSync(actualTempFile, cacheFilePath);
        
        // Stream the file to response
        const readStream = fs.createReadStream(cacheFilePath);
        readStream.pipe(res);
      } else {
        console.error('Expected output file not found');
        if (!res.headersSent) {
          res.status(500).send(`Error: ${tool} did not produce expected output file`);
        }
      }
    } else {
      console.error(`${tool} process exited with code ${code}`);
      if (!res.headersSent) {
        res.status(500).send(`Error processing video with ${tool}`);
      }
    }
  });
}

// Endpoint to check if a video exists and is available
app.get('/check/:videoId', async (req, res) => {
  try {
    const videoId = req.params.videoId;
    
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ valid: false, message: 'Invalid video ID format' });
    }
    
    try {
      const info = await ytdl.getInfo(videoId);
      
      return res.json({
        valid: true,
        title: info.videoDetails.title,
        author: info.videoDetails.author.name,
        lengthSeconds: info.videoDetails.lengthSeconds
      });
    } catch (ytdlError) {
      console.error('ytdl-core error in check endpoint:', ytdlError.message);
      
      // If youtube-dl is installed, try that instead
      if (isYoutubeDlInstalled()) {
        const { execSync } = require('child_process');
        
        try {
          // Try to get video info with youtube-dl
          const tool = (() => {
            try {
              execSync('yt-dlp --version', { stdio: 'ignore' });
              return 'yt-dlp';
            } catch (e) {
              return 'youtube-dl';
            }
          })();
          
          const output = execSync(`${tool} -j https://www.youtube.com/watch?v=${videoId}`).toString();
          const videoInfo = JSON.parse(output);
          
          return res.json({
            valid: true,
            title: videoInfo.title,
            author: videoInfo.uploader,
            lengthSeconds: videoInfo.duration
          });
        } catch (ydlError) {
          console.error(`${tool} error:`, ydlError.message);
          return res.status(400).json({ 
            valid: false, 
            message: 'Could not retrieve video information'
          });
        }
      } else {
        return res.status(400).json({ 
          valid: false, 
          message: 'Could not retrieve video information' 
        });
      }
    }
  } catch (error) {
    console.error('Error checking video:', error);
    return res.status(400).json({ 
      valid: false, 
      message: error.message || 'Could not retrieve video information'
    });
  }
});

// Get audio statistics
app.get('/stats', (req, res) => {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(file => file.endsWith('.mp3'));
    const totalSize = files.reduce((acc, file) => {
      return acc + fs.statSync(path.join(CACHE_DIR, file)).size;
    }, 0);
    
    res.json({
      cachedFiles: files.length,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      cacheDirectory: CACHE_DIR
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).send('Error retrieving statistics');
  }
});

// Clear cache endpoint (can be protected with authentication in production)
app.post('/clear-cache', (req, res) => {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    let deleted = 0;
    
    files.forEach(file => {
      const filePath = path.join(CACHE_DIR, file);
      fs.unlinkSync(filePath);
      deleted++;
    });
    
    res.json({ success: true, deletedFiles: deleted });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).send('Error clearing cache');
  }
});

app.listen(PORT, () => {
  console.log(`YouSound Backend running on port ${PORT}`);
  console.log(`Cache directory: ${CACHE_DIR}`);
  
  // Check if youtube-dl is installed
  if (isYoutubeDlInstalled()) {
    console.log('youtube-dl or yt-dlp found (available as fallback)');
  } else {
    console.log('Warning: youtube-dl/yt-dlp not found. Only ytdl-core will be used.');
  }
});