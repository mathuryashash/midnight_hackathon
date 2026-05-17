FROM node:20-alpine AS builder
WORKDIR /app
ARG NEXT_PUBLIC_USE_MOCK=true
ARG NEXT_PUBLIC_RELAYER_URL=ws://localhost:3001
ENV NEXT_PUBLIC_USE_MOCK=$NEXT_PUBLIC_USE_MOCK
ENV NEXT_PUBLIC_RELAYER_URL=$NEXT_PUBLIC_RELAYER_URL
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE 3000
CMD ["npm", "start"]
