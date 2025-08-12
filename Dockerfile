# Stable Node + Debian Bookworm
FROM node:18-bookworm

# OS deps (ffmpeg for media), Python + venv
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Create a venv so pip can install cleanly (avoids Debian pip restrictions)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# Install yt-dlp into the venv
RUN pip install --no-cache-dir yt-dlp

# App
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
