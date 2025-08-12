FROM node:18-bookworm

RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-venv && \
    rm -rf /var/lib/apt/lists/*

# yt-dlp in venv (stable on Render)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN pip install --no-cache-dir yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
