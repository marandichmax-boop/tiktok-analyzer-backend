# Node + yt-dlp image for easy deploy
FROM node:20-bullseye

# Install yt-dlp
RUN apt-get update && apt-get install -y yt-dlp && rm -rf /var/lib/apt/lists/*

# Workdir
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* /app/

# Install deps
RUN npm install --production

# Copy source
COPY . /app

# Expose port
EXPOSE 3000

# Start
CMD ["node", "server.js"]
