const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { Server } = require('socket.io');
const { clean } = require('./filter');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// ---------- Ayarlar ----------
const ADMIN_KEY = process.env.ADMIN_KEY;                       // yönetici paneli şifresi
const SALT = process.env.IP_SALT || 'selam-tuz';               // IP'leri anonimleştirmek için
const DATA_FILE = process.env.DATA_FILE || './moderation.json';
const H = 3600 * 1000;
const BAN_STEPS = [1 * H, 24 * H, 168 * H, 720 * H];           // 1 saat, 1 gün, 7 gün, 30 gün
const REPORTS_TO_BAN = 3;                                      // 24 saatte 3 farklı kişiden şikayet
const REASONS = {
  nudity: 'Müstehcen görüntü',
  harass: 'Taciz veya küfür',
  minor: 'Reşit olmadığı düşünülen biri',
  spam: 'Spam veya reklam',
  other: 'Diğer',
};

// ---------- Kalıcı kayıt (IP'ler yalnızca özet/hash olarak saklanır) ----------
let db = { reports: [], bans: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}
const save = () => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); }
  catch (e) { console.error('Kayıt yazılamadı:', e.message); }
};

const ipOf = (s) => {
  const xff = s.handshake.headers['x-forwarded-for'];
  return xff ? xff.split(',').pop().trim() : s.handshake.address;
};
const hashOf = (s) => crypto.createHash('sha256').update(SALT + ipOf(s)).digest('hex').slice(0, 12);
const isBanned = (h) => db.bans[h] && db.bans[h].until > Date.now();

// ---------- ICE (STUN/TURN) ----------
app.get('/ice', (req, res) => {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    list.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  }
  res.json(list);
});

// ---------- Yönetici paneli: /admin?key=ŞİFRE ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const adminOK = (req) => ADMIN_KEY && req.query.key === ADMIN_KEY;
const fmt = (t) => new Date(t).toLocaleString('tr-TR');

app.get('/admin', (req, res) => {
  if (!adminOK(req)) return res.status(404).send('Not found');
  const k = encodeURIComponent(req.query.key);
  const bans = Object.entries(db.bans).filter(([, b]) => b.until > Date.now())
    .map(([h, b]) => `<tr><td>${esc(h)}</td><td>${fmt(b.until)}</td><td>${b.strikes}</td><td><a href="/admin/unban?key=${k}&h=${esc(h)}">Engeli kaldır</a></td></tr>`).join('');
  const reports = db.reports.slice(-50).reverse()
    .map((r) => `<tr><td>${fmt(r.t)}</td><td>${esc(REASONS[r.reason] || r.reason)}</td><td>${esc(r.target)}</td><td><a href="/admin/ban?key=${k}&h=${esc(r.target)}">7 gün engelle</a></td></tr>`).join('');
  res.send(`<!DOCTYPE html><meta charset="utf-8"><title>Selam yönetim</title>
<style>body{font-family:sans-serif;margin:24px}table{border-collapse:collapse;margin-bottom:28px}td,th{border:1px solid #999;padding:6px 10px;text-align:left}</style>
<h2>Aktif engeller</h2><table><tr><th>Kullanıcı</th><th>Bitiş</th><th>Ceza sayısı</th><th></th></tr>${bans || '<tr><td colspan="4">Yok</td></tr>'}</table>
<h2>Son şikayetler</h2><table><tr><th>Zaman</th><th>Neden</th><th>Şikayet edilen</th><th></th></tr>${reports || '<tr><td colspan="4">Yok</td></tr>'}</table>`);
});
app.get('/admin/unban', (req, res) => {
  if (!adminOK(req)) return res.status(404).send('Not found');
  delete db.bans[String(req.query.h)]; save();
  res.redirect('/admin?key=' + encodeURIComponent(req.query.key));
});
app.get('/admin/ban', (req, res) => {
  if (!adminOK(req)) return res.status(404).send('Not found');
  const h = String(req.query.h), prev = db.bans[h];
  db.bans[h] = { until: Date.now() + 168 * H, strikes: (prev ? prev.strikes : 0) + 1 }; save();
  res.redirect('/admin?key=' + encodeURIComponent(req.query.key));
});

// ---------- Eşleştirme ----------
let waiting = null;
const partner = new Map();       // socket.id -> eşleşen socket.id
const lastChat = new Map();      // socket.id -> son mesaj zamanı
const lastJoin = new Map();      // socket.id -> son arama zamanı
const reporterLog = new Map();   // özet -> son şikayet zamanları
const ipCount = new Map();       // özet -> açık bağlantı sayısı

function unpair(id) {
  if (waiting === id) waiting = null;
  const p = partner.get(id);
  if (p) { partner.delete(id); partner.delete(p); io.to(p).emit('partner-left'); }
}

io.on('connection', (socket) => {
  const me = hashOf(socket);
  const n = (ipCount.get(me) || 0) + 1;
  ipCount.set(me, n);
  if (n > 5) { socket.emit('blocked'); socket.disconnect(true); return; }   // aynı IP'den en fazla 5 bağlantı

  let pendingJoin = false;
  const doJoin = () => {
    pendingJoin = false;
    if (!socket.connected) return;
    if (isBanned(me)) return socket.emit('blocked');
    lastJoin.set(socket.id, Date.now());
    unpair(socket.id);

    if (waiting && waiting !== socket.id && io.sockets.sockets.has(waiting)) {
      const other = waiting; waiting = null;
      partner.set(socket.id, other); partner.set(other, socket.id);
      io.to(other).emit('matched', { initiator: true });
      socket.emit('matched', { initiator: false });
    } else {
      waiting = socket.id;
      socket.emit('waiting');
    }
  };
  socket.on('join', () => {
    if (pendingJoin) return;
    const wait = 800 - (Date.now() - (lastJoin.get(socket.id) || 0));   // çok hızlı "Sonraki" basmayı yavaşlat
    if (wait > 0) { pendingJoin = true; setTimeout(doJoin, wait); } else doJoin();
  });

  socket.on('signal', (data) => { const p = partner.get(socket.id); if (p) io.to(p).emit('signal', data); });

  socket.on('chat', (text) => {
    const p = partner.get(socket.id);
    if (!p || typeof text !== 'string') return;
    const now = Date.now();
    if (now - (lastChat.get(socket.id) || 0) < 400) return;
    lastChat.set(socket.id, now);
    const msg = clean(text.trim().slice(0, 500));
    if (msg) io.to(p).emit('chat', msg);
  });

  socket.on('leave', () => unpair(socket.id));

  socket.on('report', (reason) => {
    const p = partner.get(socket.id);
    const target = p && io.sockets.sockets.get(p);
    if (!target) return;
    const them = hashOf(target), now = Date.now();
    if (them === me) return;
    const recent = (reporterLog.get(me) || []).filter((t) => now - t < H);
    if (recent.length >= 10) return unpair(socket.id);                      // şikayet sistemini kötüye kullanmayı sınırla
    recent.push(now); reporterLog.set(me, recent);

    db.reports.push({ t: now, reason: REASONS[reason] ? reason : 'other', by: me, target: them });
    if (db.reports.length > 500) db.reports.shift();

    const open = db.reports.filter((r) => r.target === them && !r.handled && now - r.t < 24 * H);
    if (new Set(open.map((r) => r.by)).size >= REPORTS_TO_BAN) {
      const strikes = db.bans[them] ? db.bans[them].strikes : 0;
      db.bans[them] = { until: now + BAN_STEPS[Math.min(strikes, BAN_STEPS.length - 1)], strikes: strikes + 1 };
      open.forEach((r) => { r.handled = true; });
      target.emit('blocked');
      console.log(`[engel] ${them} ceza=${strikes + 1}`);
    }
    save();
    unpair(socket.id);
  });

  socket.on('disconnect', () => {
    unpair(socket.id); lastChat.delete(socket.id); lastJoin.delete(socket.id);
    const c = (ipCount.get(me) || 1) - 1;
    if (c <= 0) ipCount.delete(me); else ipCount.set(me, c);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Selam çalışıyor: http://localhost:${PORT}`));
