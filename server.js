const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let waiting = null;            // kuyrukta bekleyen kullanıcı
const partner = new Map();     // socket.id -> eşleşen socket.id
const reports = new Map();     // ip -> şikayet sayısı
const blocked = new Map();     // ip -> engel bitiş zamanı

// Proxy arkasında (Render vb.) gerçek IP için son x-forwarded-for değerini kullan
const ipOf = (s) => {
  const xff = s.handshake.headers['x-forwarded-for'];
  return xff ? xff.split(',').pop().trim() : s.handshake.address;
};

// STUN/TURN ayarlarını ortam değişkenlerinden istemciye ver
app.get('/ice', (req, res) => {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }
  res.json(list);
});

const lastChat = new Map();    // socket.id -> son mesaj zamanı

function unpair(id) {
  if (waiting === id) waiting = null;
  const p = partner.get(id);
  if (p) {
    partner.delete(id);
    partner.delete(p);
    io.to(p).emit('partner-left');
  }
}

io.on('connection', (socket) => {
  socket.on('join', () => {
    if ((blocked.get(ipOf(socket)) || 0) > Date.now()) return socket.emit('blocked');
    unpair(socket.id);

    if (waiting && waiting !== socket.id && io.sockets.sockets.has(waiting)) {
      const other = waiting;
      waiting = null;
      partner.set(socket.id, other);
      partner.set(other, socket.id);
      io.to(other).emit('matched', { initiator: true });
      socket.emit('matched', { initiator: false });
    } else {
      waiting = socket.id;
      socket.emit('waiting');
    }
  });

  // SDP ve ICE bilgilerini eşleşen kişiye aktar
  socket.on('signal', (data) => {
    const p = partner.get(socket.id);
    if (p) io.to(p).emit('signal', data);
  });

  socket.on('chat', (text) => {
    const p = partner.get(socket.id);
    if (!p || typeof text !== 'string') return;
    const now = Date.now();
    if (now - (lastChat.get(socket.id) || 0) < 400) return;   // hız sınırı
    lastChat.set(socket.id, now);
    const clean = text.trim().slice(0, 500);
    if (clean) io.to(p).emit('chat', clean);
  });

  socket.on('leave', () => unpair(socket.id));

  socket.on('report', () => {
    const p = partner.get(socket.id);
    const target = p && io.sockets.sockets.get(p);
    if (!target) return;
    const ip = ipOf(target);
    const n = (reports.get(ip) || 0) + 1;
    reports.set(ip, n);
    console.log(`[şikayet] ${new Date().toISOString()} ip=${ip} toplam=${n}`);
    if (n >= 3) {                       // 3 şikayet = 1 saat engel
      blocked.set(ip, Date.now() + 60 * 60 * 1000);
      reports.set(ip, 0);
      target.emit('blocked');
    }
    unpair(socket.id);
  });

  socket.on('disconnect', () => { unpair(socket.id); lastChat.delete(socket.id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Selam çalışıyor: http://localhost:${PORT}`));
