FROM node:lts as builder

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY . .

RUN npm ci

CMD [ "npm", "start" ]