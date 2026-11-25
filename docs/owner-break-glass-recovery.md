# DecorBiz — Owner Break-Glass Recovery Guide

When an IP allowlist mistake, dynamic ISP IP change, or lost 2FA device prevents the Owner from accessing `/ERP`, use one of the verified **Owner Break-Glass Recovery** procedures below. Customer traffic at `/` and `/api/store/*` is never affected by ERP IP allowlists.

---

## Method 1 — Break-Glass Secret Header (`DECORBIZ_BREAKGLASS_TOKEN`) [Recommended]

Pre-configure a high-entropy token in your Vercel / server environment variables (never expose via `VITE_*`):

```dotenv
DECORBIZ_BREAKGLASS_TOKEN="<long-random-hex-or-passphrase>"
```

### How to Recover
1. Send a request or configure a browser header extension (`ModHeader` / `curl`) with:
   ```text
   X-Break-Glass-Token: <your-DECORBIZ_BREAKGLASS_TOKEN>
   ```
2. Open `https://<your-domain>/ERP` → sign in as **Owner** → navigate to **Settings → Security & IP**.
3. Update or clear the IP allowlist to add your current public IP address, then save.
4. Disable your temporary header extension once normal access is restored.

---

## Method 2 — Emergency Static Break-Glass IP (`DECORBIZ_BREAKGLASS_IP`)

1. Find your current public IPv4 address (e.g., `203.0.113.42`).
2. In **Vercel Dashboard → Settings → Environment Variables** (or VPS `.env`), add:
   ```dotenv
   DECORBIZ_BREAKGLASS_IP="203.0.113.42"
   ```
3. Redeploy (or restart the Node server).
4. Access `/ERP`, fix **Settings → Security & IP → IP Allowlist**, and remove `DECORBIZ_BREAKGLASS_IP` when finished.

---

## Method 3 — Temporary Global Bypass (`BYPASS_IP_ALLOWLIST=true`)

If you cannot inject custom HTTP headers and do not have a static IP:
1. In Vercel / server environment variables, temporarily set:
   ```dotenv
   BYPASS_IP_ALLOWLIST="true"
   ```
2. Redeploy / restart the server.
3. Immediately log in to `/ERP` → **Settings → Security & IP**, correct or clear the IP allowlist.
4. **Critical**: Delete `BYPASS_IP_ALLOWLIST` or set it back to `"false"` and redeploy right away so `/ERP` IP enforcement resumes.

---

## Method 4 — Direct Database Reset (Supabase SQL Editor)

If you have Supabase Dashboard access:
1. Open **Supabase Dashboard → SQL Editor → New Query**.
2. Clear the ERP IP allowlist cleanly:
   ```sql
   UPDATE public.business
   SET allowed_ips = '{}'::text[]
   WHERE id = 1;
   ```
3. Access `https://<your-domain>/ERP` immediately (an empty `allowed_ips` list permits all IPs until you re-add trusted office/home IPs).

---

## Recovering a Lost Owner 2FA (TOTP) Authenticator

1. **Try a Recovery Code First**: When you enabled 2FA, DecorBiz generated 8 single-use recovery codes (stored as SHA-256 hashes). Enter any unused recovery code directly in the 2FA verification box at `/ERP` login.
2. **Direct Database Reset (Supabase SQL Editor)** — if both phone and recovery codes are lost:
   ```sql
   -- Find your owner user ID by email
   SELECT id, email, role FROM public.profiles WHERE role = 'owner';

   -- Reset 2FA for that owner user ID
   DELETE FROM public.staff_totp
   WHERE user_id = '<OWNER_UUID_FROM_ABOVE>';
   ```
3. Sign back in to `/ERP` with your password, then re-enroll a new authenticator under **My Profile → Two-Factor Authentication** and store the fresh recovery codes safely.
