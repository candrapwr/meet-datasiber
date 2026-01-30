# Meet Datasiber

Meet Datasiber adalah aplikasi video meeting berbasis WebRTC untuk tim: waiting room, chat, screen share, dan recording lokal. Proyek ini dibuat supaya mudah dikembangkan ke fitur enterprise ke depan.

## Ringkasan fitur

- Video call multi-user (mesh WebRTC)
- Waiting room + approval host
- Chat realtime di room
- Screen share dengan mode fullscreen + strip peserta
- Recording lokal (download WebM)
- UI responsif dan ringan

## Arsitektur singkat

- Client: Next.js (App Router) + Socket.IO client
- UI, WebRTC, dan state room berjalan di browser
- Server: Node.js + Express + Socket.IO
- Signaling: offer/answer/ICE + manajemen room/host/pending
- STUN/TURN: eksternal (contoh: `stun.datasiber.com`)

## Struktur proyek

```
/apps
  /client        # Next.js UI + WebRTC
  /server        # Signaling server (Socket.IO)
```

## Quick start (dev)

1) Copy env

```bash
cp .env.example .env
```

2) Install deps

```bash
npm install
```

3) Run dev

```bash
npm run dev
```

- Client: http://localhost:3000
- Signaling: http://localhost:3001

## Konfigurasi environment

### Root `.env`

```
# Client (Next.js)
NEXT_PUBLIC_SIGNALING_URL=http://localhost:3001
NEXT_PUBLIC_STUN_URL=
NEXT_PUBLIC_TURN_URL=turn:stun.datasiber.com:443?transport=tcp
NEXT_PUBLIC_TURN_USERNAME=replace_me
NEXT_PUBLIC_TURN_PASSWORD=replace_me

# Server
PORT=3001
ALLOWED_ORIGIN=http://localhost:3000
```

Catatan:
- Jika TURN butuh TCP, gunakan `?transport=tcp`.
- Jika STUN tidak dipakai, kosongkan `NEXT_PUBLIC_STUN_URL`.

## Alur WebRTC (ringkas)

1) User join room → server tentukan host.
2) User non-host masuk waiting room.
3) Host approve → server kirim `existing-peers` ke user baru.
4) User baru membuat offer ke semua peserta yang sudah ada.
5) Peserta lama menjawab answer + tukar ICE candidate.

## Event Socket.IO (signaling)

Server menerima/mengirim event berikut:

- `join-room` → user join room (name, roomId)
- `waiting` → user diminta menunggu host
- `approved` → user di-approve host
- `pending-list` → daftar user menunggu
- `existing-peers` → dikirim ke user baru berisi peserta yang sudah ada
- `peer-joined` → dikirim ke peserta lama saat ada user baru
- `peer-left` → user keluar
- `signal` → offer/answer/ice-candidate
- `chat` → pesan chat room
- `participants` → daftar peserta aktif
- `screen-share` → status share screen (active/inactive)

## UI layout

- Grid mode: semua video tile dalam grid.
- Stage mode: 1 tile besar (fullscreen) + strip peserta di kanan.
- Chat dan peserta dipisah menjadi panel sendiri (scrollable).

## Recording

- Menggunakan MediaRecorder dari stream lokal.
- Output WebM di-download oleh browser.
- Untuk recording gabungan (semua peserta), perlu mix stream (lanjutan).

## Deploy (ringkas)

1) Build:
```bash
npm run build
```

2) Run:
```bash
npm run dev:server
npm run start -w @meet-datasiber/client
```

3) Reverse proxy (Nginx + 1 domain):
- Next.js di port 3000
- Signaling di port 3001 (path `/socket.io/`)

## Catatan teknis penting

- WebRTC butuh HTTPS di production.
- Jika video off default, kamera tidak dinyalakan di awal.
- Perfect negotiation diterapkan untuk menghindari collision offer/answer.
- Saat user mematikan kamera, track dihentikan untuk hemat bandwidth.

## Saran pengembangan lanjut

- Simulcast + SFU (Janus/Mediasoup) untuk skala besar
- Recording server-side
- Admin dashboard
- Integrasi auth (JWT/SSO)
- Moderasi host (mute/kick)
