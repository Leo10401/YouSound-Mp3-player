#!/bin/bash
# Create bin directory if it doesn't exist
mkdir -p ./bin

# Download yt-dlp directly to ensure it's available
echo "Downloading yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ./bin/yt-dlp
chmod +x ./bin/yt-dlp

# Display version for debugging
echo "yt-dlp version:"
./bin/yt-dlp --version

# Start the application
echo "Starting application..."
node index.js