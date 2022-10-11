
FROM node:lts-alpine3.15@sha256:a2c7f8ebdec79619fba306cec38150db44a45b48380d09603d3602139c5a5f92

RUN mkdir -p /app
WORKDIR /app

RUN apk add python3 \
        make \
        g++ 

COPY . .

WORKDIR /app/relayer/relayer-plugin-interface

RUN npm ci && \
    npm run build

# TODO handle all plugins in this directory
WORKDIR /app/relayer/plugins/dummy_plugin

RUN npm ci && \
    npm run build


WORKDIR /app/relayer/plugin_relayer

RUN npm ci && \
    npm run build