// Service Worker برای CRM حرفه‌ای مشاور املاک
// نسخه کش را با هر آپدیت مهم فایل index.html افزایش دهید
const CACHE_NAME = 'amlak-crm-cache-v3';
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  // عمداً skipWaiting فراخوانی نمی‌شود؛ ورکر جدید در حالت «waiting» می‌ماند
  // تا کاربر با دکمه «بروزرسانی الان» در نوار اطلاع‌رسانی، خودش تأیید کند.
});

// وقتی صفحه پیام SKIP_WAITING بفرستد (کاربر روی «بروزرسانی الان» زده)، نسخه جدید فعال می‌شود
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// استراتژی: اول شبکه، اگر شکست خورد از کش بخوان (برای اینکه همیشه آخرین نسخه اپ لود شود
// و در نبود اینترنت هم برنامه بالا بیاید)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});
