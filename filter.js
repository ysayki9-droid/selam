// Basit mesaj filtresi: bağlantıları gizler, yaygın küfürleri yıldızlar.
// Not: Bu liste temel düzeydedir, kolayca atlatılabilir. Gerçek kullanımda
// kendi listenle genişlet veya bir moderasyon servisi ekle.
const STEMS = ['orospu', 'siktir', 'sikeyim', 'sikerim', 'yarrak', 'pezevenk', 'amcik',
               'gotveren', 'ibne', 'fuck', 'bitch', 'cunt', 'asshole'];
const EXACT = ['amk', 'aq', 'oc'];

const BAD = [
  new RegExp('\\b(?:' + STEMS.join('|') + ')\\w*', 'g'),
  new RegExp('\\b(?:' + EXACT.join('|') + ')\\b', 'g'),
];

// Türkçe harfleri sadeleştir (uzunluk korunur, böylece konumlar aynı kalır)
const fold = (s) => s.toLocaleLowerCase('tr')
  .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
  .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');

function clean(text) {
  const out = text.replace(/(https?:\/\/|www\.)\S+/gi, '[bağlantı]');
  const f = fold(out);
  const chars = out.split('');
  for (const re of BAD) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(f))) {
      for (let i = m.index; i < m.index + m[0].length; i++) chars[i] = '*';
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return chars.join('');
}

module.exports = { clean };
