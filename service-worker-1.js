// Service Worker برای CRM حرفه‌ای مشاور املاک
// استراتژی: اول شبکه، اگر نبود از کش (برنامه همیشه آخرین نسخه را می‌گیرد و آفلاین هم بالا می‌آید).
// نیازی نیست با هر آپدیت index.html عدد کش را بالا ببرید؛ فقط وقتی خودِ این فایل تغییر می‌کند.
const CACHE_NAME = 'amlak-crm-cache-v4';
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// درخواست‌های لایسنس و همگام‌سازی هرگز نباید کش شوند؛ وگرنه در حالت آفلاین
// پاسخ قدیمیِ «معتبر» برگردانده می‌شود و محدودیت ۱۴ روزه آفلاین بی‌اثر می‌شود.
const NO_CACHE_HOSTS = ['script.google.com', 'script.googleusercontent.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // اگر یک فایل (مثلاً آیکون) روی هاست نبود، نصب ورکر کلاً شکست نخورد
      Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {})))
    )
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (NO_CACHE_HOSTS.includes(url.hostname)) return; // مستقیم به شبکه

  event.respondWith(
    fetch(req)
      .then((response) => {
        // فقط پاسخ سالم کش شود تا صفحهٔ خطا (۴۰۴/۵۰۰) نسخهٔ خوب را خراب نکند
        if (response && response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          // فقط برای باز کردن صفحه، index.html؛ برای بقیه (API، تصویر...) خطای شبکهٔ واقعی
          return req.mode === 'navigate' ? caches.match('./index.html') : Response.error();
        })
      )
  );
});
