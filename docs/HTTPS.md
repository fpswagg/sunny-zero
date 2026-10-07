# A public HTTPS address

Sunny works without HTTPS (Telegram bots use long polling and need no open port). But some features need a URL your phone can open:

- **secure pages** where you type passwords, API keys and bot tokens;
- **sign-ins** with Google, GitHub, Spotify… (OAuth redirects);
- the **Telegram Mini App** (`/manage`) and the **agent apps** (`/app`: chat and voice calls in a browser);
- **webhooks** from other apps (`POST /events/<source>`).

## The easy way: Caddy (included)

Caddy gets and renews a Let's Encrypt certificate by itself.

1. **A domain name.** Point a domain (or subdomain) at your VPS's IP with an `A` record, e.g. `sunny.example.com`. No domain? Use a free [sslip.io](https://sslip.io) name: `sunny.<your-ip-with-dashes>.sslip.io` (for `203.0.113.7`: `sunny.203-0-113-7.sslip.io`) points to your IP with no setup.
2. **Open ports 80 and 443** in your VPS provider's firewall (and `ufw` if you use it: `sudo ufw allow 80,443/tcp`).
3. **Start Caddy:**
   ```sh
   SUNNY_HOST=sunny.example.com docker compose -f docker/caddy.yml up -d
   ```
4. **Tell Sunny** in `.env`, then restart:
   ```sh
   SUNNY_PUBLIC_URL=https://sunny.example.com
   ```
   ```sh
   pnpm pm2:start
   ```
5. Check: `curl https://sunny.example.com/health` answers `{"ok":true}`.

Sunny keeps listening on `127.0.0.1:3210`; only Caddy is exposed.

## Your own reverse proxy

Already running nginx, Traefik or another proxy on 80/443? Route your domain to `http://127.0.0.1:3210` and set `SUNNY_PUBLIC_URL`. WebSockets must pass through (`/ws`, `/a/<agent>/ws`).

nginx example:

```nginx
server {
  server_name sunny.example.com;
  listen 443 ssl;   # certificates from certbot
  client_max_body_size 30m;
  location / {
    proxy_pass http://127.0.0.1:3210;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
  }
}
```

If your proxy runs in Docker without host networking, it cannot reach `127.0.0.1` on the host: set `SUNNY_BIND=0.0.0.0` and **block port 3210 from the internet** (`sudo ufw deny 3210/tcp`, or an `iptables` rule on the public interface, IPv4 and IPv6), so plain HTTP never leaves the server.

## Cloudflare Tunnel

No open ports at all: `cloudflared tunnel --url http://127.0.0.1:3210` with a named tunnel and your domain, then set `SUNNY_PUBLIC_URL` to the tunnel's hostname.
