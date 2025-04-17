import express from 'express';
import cors from 'cors';
import { YtDlp } from 'ytdlp-nodejs';
import NodeCache from 'node-cache';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT;
const ytDlp = new YtDlp();
const audioCache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache

app.use(cors());

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

app.listen(PORT, () => {
  console.log(`🎧 Audio server running on http://localhost:${PORT}`);
});
