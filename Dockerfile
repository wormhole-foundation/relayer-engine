FROM --platform=linux/amd64 node:lts-alpine as builder

WORKDIR /usr/src/app

COPY . .