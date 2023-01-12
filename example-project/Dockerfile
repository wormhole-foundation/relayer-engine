FROM node:lts as builder

# Create app directory
WORKDIR /usr/src

# COPY package.json package-lock.json /src/

# ENV NODE_ENV=production
# RUN npm ci

# Install app dependencies
# COPY . /src

COPY node_modules .
COPY . .

CMD [ "npm", "start" ]