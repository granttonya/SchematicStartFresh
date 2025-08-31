const CACHE_NAME = 'schematic-studio-v6';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './app.js?v=3',
  './cv-worker.js',
  'https://unpkg.com/utif@3.1.0/UTIF.min.js',
  'https://docs.opencv.org/4.x/opencv.js'
];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', (e)=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e)=>{
  const req = e.request;
  // Network-first for JSON project files; cache-first for app shell
  if(req.method!=='GET'){ return }
  const url = new URL(req.url);
  if(url.origin===location.origin){
    if(ASSETS.includes(url.pathname) || url.pathname==='/'){
      e.respondWith(caches.match(req).then(r=>r||fetch(req)));
      return;
    }
  }
  e.respondWith(fetch(req).catch(()=>caches.match(req)));
});
