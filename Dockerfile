FROM node:22-bookworm-slim

# Install system dependencies required by the converter
RUN apt-get update && apt-get install -y \
    libreoffice \
    poppler-utils \
    python3 \
    python3-pip \
    fonts-dejavu \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Install pdf2docx for PDF -> DOCX conversion
RUN pip3 install --no-cache-dir --break-system-packages pdf2docx

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the application
COPY . .

# Create directories used by the application
RUN mkdir -p /app/server/uploads /app/server/converted

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start the Express server
CMD ["node", "server/index.js"]