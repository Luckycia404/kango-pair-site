# Kango Pair — portable deployment

Kango Pair is a Node.js/Express WhatsApp pairing and QR website. The same source package can run on Northflank, Heroku, Replit, Railway, Render, or a VPS; it does not depend on a Northflank-only API.

## Requirements and local run

- Node.js 20 or newer
- npm 9.7.2 or newer
- Outbound network access to WhatsApp Web for pairing requests

```sh
npm ci
npm start
```

Open `http://localhost:8000`. The server uses the platform-provided `PORT` when present and falls back to `8000`; do not hard-code a different port in a hosting dashboard. It is a long-running web process, not a serverless function. A host that sleeps or restarts the service can interrupt an in-progress pairing request.

Pairing/auth files are temporary and are written under `temp/<request-id>` while a pairing request runs. Treat them as credentials. The app cleans up temporary state after a request, but never commit or share those files. The deployment ZIP omits `temp/`, backups, `.git`, `node_modules`, and environment files. Deploy from a private repository and do not put WhatsApp session data in the source archive.

## Choose a host

All methods below run the same `npm start` web process. For the Docker option, use the included `Dockerfile`; it installs production dependencies and listens on port `8000` by default while still honoring a platform-provided `PORT`.

### Northflank

1. Create a service from the private Git repository or upload the source to a repository.
2. Select **Dockerfile** as the build method and use the included root `Dockerfile`.
3. Expose the container's HTTP port `8000` (or the port configured by the service environment).
4. Add a domain in the service's domain settings if you want a custom hostname.

See [Northflank: build with a Dockerfile](https://northflank.com/docs/v1/application/build/build-with-a-dockerfile) and [expose your application](https://northflank.com/docs/v1/application/network/expose-your-application).

### Heroku

1. Deploy the source with the Node.js buildpack; `app.json` selects that buildpack.
2. The included `Procfile` starts the correct web process: `web: npm start`.
3. Heroku supplies `PORT` automatically. Do not set a fixed port in the dashboard.
4. For a custom hostname, add it under the app's **Settings → Domains** and use the DNS target Heroku displays.

See [Heroku: deploy Node.js apps](https://devcenter.heroku.com/articles/deploying-nodejs) and [custom domains](https://devcenter.heroku.com/articles/custom-domains).

### Replit

1. Import the source ZIP or a private repository into a Replit app.
2. The included `.replit` file runs `npm start` and maps the app's internal port `8000` to the public web port.
3. Run the app; for a published service, use Replit's publishing flow.
4. To use a custom hostname, add it in the app's **Publishing → Domains** settings, then copy the A and TXT records Replit provides into Cloudflare. Keep the TXT verification record in place.

See [Replit ports](https://docs.replit.com/features/project-setup/ports) and [connect a custom domain](https://docs.replit.com/build/add-custom-domain).

### Railway

1. Deploy the private repository and select the included `Dockerfile`. Alternatively, use the Node.js runtime with install command `npm ci` and start command `npm start`.
2. Railway supplies `PORT`; the app reads it at startup.
3. Add the custom domain in Railway's service settings. Copy **both** the CNAME record and the TXT verification record Railway shows into Cloudflare.

See [Railway: domains](https://docs.railway.com/networking/domains/working-with-domains).

### Render

1. Create a **Web Service** from the private repository. Use the included Dockerfile, or choose the Node runtime with build command `npm ci` and start command `npm start`.
2. Add the custom hostname in the service's **Settings → Custom Domains** and copy the CNAME target Render provides into Cloudflare.
3. For initial domain verification, use **DNS only** in Cloudflare as Render instructs. Change proxy status only after the domain and TLS certificate are active and the provider supports it.

See [Render: configure Cloudflare DNS](https://render.com/docs/configure-cloudflare-dns).

### VPS (Node.js or Docker)

For a standard Node.js install, extract the ZIP, install Node.js 20+, then run:

```sh
npm ci --omit=dev
NODE_ENV=production PORT=8000 npm start
```

For a Docker-based VPS, build and run the included Dockerfile, publishing container port `8000`. For a persistent service, run Node under `systemd` or another process manager and put Nginx or Caddy in front of it for HTTPS. Example systemd service (adjust the paths and Node binary path for your server):

```ini
[Unit]
Description=Kango Pair
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/pairingsite
Environment=NODE_ENV=production
Environment=PORT=8000
ExecStart=/usr/bin/node /opt/pairingsite/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Keep the Node port private behind the reverse proxy; allow public HTTP/HTTPS traffic through the proxy instead. Point the hostname's DNS to the VPS public IP.

## Cloudflare subdomain

Example hostname: `pair.officialkango.online`. Create the hostname in the selected hosting provider first; use the exact DNS target or verification records it displays. Then, in Cloudflare **DNS → Records**, create the records for the `pair` subdomain:

- **Northflank, Heroku, Railway, or Render:** usually a CNAME to the provider's generated target. Use the exact target shown by that provider. Railway also requires its TXT verification record; other providers may request additional records.
- **Replit:** add the A and TXT records shown in Replit's custom-domain settings.
- **VPS:** use an A record named `pair` pointing to the VPS's public IPv4 address. Add an AAAA record only if the VPS has working public IPv6.

Start with Cloudflare's proxy set to **DNS only** while the host verifies the domain and issues TLS. After that succeeds, enable the proxy only if the host's TLS configuration supports Cloudflare in front of it. For a VPS, configure a valid HTTPS certificate on Nginx/Caddy before enabling the proxy; use Cloudflare SSL/TLS mode **Full (strict)** when the origin has a valid certificate.

A single hostname can direct traffic to only one active host at a time. When moving providers, change the DNS target and update or remove the old custom-domain binding. DNS can take time to propagate.

## Deployment notes

- `npm start` is the shared start command; `PORT` is supplied by the host, with `8000` as the local/default port.
- Keep the service running while a user completes pairing. Sleeping/serverless runtimes are not suitable for an in-progress pairing flow.
- Keep the source repository private. Never include `.env` files, `temp/` contents, backups, or generated WhatsApp session credentials in a public ZIP or Git repository.
