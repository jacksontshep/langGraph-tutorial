# Use lightweight Node image
FROM nodesource/nsolid:latest

# Create app directory
WORKDIR /app

# Install app dependencies (including dev dependencies for TypeScript)
COPY package*.json ./
RUN npm ci

# Bundle app source
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Expose application port
EXPOSE 2999

# Run the compiled JavaScript directly
CMD ["node", "dist/multi-agent.js"]
