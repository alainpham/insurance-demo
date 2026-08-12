# Grab the Grafana Alloy binary from the official image
FROM grafana/alloy:latest AS alloy

# Use the official Node.js image as the base image
FROM node:22

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev --quiet

# Copy the rest of the application code
COPY public ./public
COPY server ./server

# Bring in Alloy so it can tail the app's log file and ship it to Loki
COPY --from=alloy /bin/alloy /usr/local/bin/alloy
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose the port the app runs on
EXPOSE 8080

# LOKI_ENDPOINT, LOKI_USER and LOKI_PASSWORD must be provided at runtime
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]