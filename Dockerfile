FROM node:20-bookworm-slim AS build

WORKDIR /app

ARG VITE_PUBLIC_SITE_URL=https://www.uckelegroup.com
ARG VITE_PUBLIC_CONTACT_EMAIL=mathew@uckelegroup.com
ARG VITE_PUBLIC_CONTACT_PHONE=914.361.9153
ARG VITE_PUBLIC_LINKEDIN_URL=https://www.linkedin.com/in/mathew-uckele
ARG VITE_TURNSTILE_SITE_KEY=

ENV VITE_PUBLIC_SITE_URL=$VITE_PUBLIC_SITE_URL
ENV VITE_PUBLIC_CONTACT_EMAIL=$VITE_PUBLIC_CONTACT_EMAIL
ENV VITE_PUBLIC_CONTACT_PHONE=$VITE_PUBLIC_CONTACT_PHONE
ENV VITE_PUBLIC_LINKEDIN_URL=$VITE_PUBLIC_LINKEDIN_URL
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist

EXPOSE 8787

CMD ["node", "server/index.js"]
