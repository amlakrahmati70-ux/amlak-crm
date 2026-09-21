#!/usr/bin/env node
/**
 * تست رگرسیون دائمی CRM املاک
 * ==============================
 * این فایل رو کنار فایل HTML اصلی برنامه (مثلاً CRM_amlak_v81.html) نگه دارید و
 * بعد از هر تغییری که خودتون یا هر Claude دیگه‌ای توی برنامه دادید، اجرا کنید تا
 * مطمئن بشید چیزی که قبلاً درست کار می‌کرد، خراب نشده.
 *
 * نحوه‌ی اجرا (فقط یک‌بار لازمه نصب کنید):
 *   npm install playwright
 *   npx playwright install chromium
 *
 * بعد هر بار برای اجرای تست:
 *   node crm-regression-test.js /path/to/CRM_amlak_vNN.html
 *
 * اگه مسیر فایل رو ندید، خودش دنبال یه فایل CRM_amlak*.html توی همین پوشه می‌گرده.
 *
 * خروجی: یه لیست ✅/❌ برای هر تست، و در پایان خلاصه. اگه حتی یک ❌ باشه، برنامه
 * با کد خروج ۱ تموم می‌شه (یعنی "یه چیزی خراب شده، قبل از ارسال به کاربر واقعی چک کن").
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

// ---------- پیدا کردن فایل HTML هدف ----------
let targetFile = process.argv[2];
if (!targetFile) {
  const candidates = fs.readdirSync(__dirname).filter(f => /^CRM_amlak.*\.html$/i.test(f));
  if (!candidates.length) {
    console.error('❌ هیچ فایل CRM_amlak*.html پیدا نشد. مسیر فایل رو صریح بدید:\n   node crm-regression-test.js /path/to/file.html');
    process.exit(1);
  }
  // جدیدترین فایل (بر اساس تاریخ تغییر) رو انتخاب کن
  candidates.sort((a, b) => fs.statSync(path.join(__dirname, b)).mtimeMs - fs.statSync(path.join(__dirname, a)).mtimeMs);
  targetFile = path.join(__dirname, candidates[0]);
}
targetFile = path.resolve(targetFile);
if (!fs.existsSync(targetFile)) {
  console.error(`❌ فایل پیدا نشد: ${targetFile}`);
  process.exit(1);
}
console.log(`🎯 فایل هدف: ${targetFile}\n`);

// ---------- زیرساخت ساده‌ی گزارش‌دهی ----------
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- بخش ۱: بررسی‌های ایستا (بدون نیاز به مرورگر) ----------
function runStaticChecks() {
  console.log('── بررسی‌های ایستا (سینتکس و تکرار) ──');
  const html = fs.readFileSync(targetFile, 'utf-8');
  const scriptBlocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);

  // سینتکس هر بلاک اسکریپت (با node --check روی هر بلاک به‌صورت جدا)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
  scriptBlocks.forEach((code, i) => {
    if (!code.trim() || code.trim().startsWith('{')) return; // importmap و بلاک‌های JSON رو رد کن
    const tmpFile = path.join(tmpDir, `block${i}.js`);
    fs.writeFileSync(tmpFile, code, 'utf-8');
    try {
      execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
      record(`سینتکس بلاک اسکریپت #${i}`, true);
    } catch (e) {
      record(`سینتکس بلاک اسکریپت #${i}`, false, e.stderr ? e.stderr.toString().split('\n')[0] : e.message);
    }
  });

  // پیدا کردن بزرگ‌ترین بلاک (اسکریپت اصلی برنامه) برای بقیه‌ی بررسی‌های ایستا
  const mainScript = scriptBlocks.reduce((a, b) => (b.length > a.length ? b : a), '');

  // توابع تکراری در سطح بالا
  const fnNames = [...mainScript.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)].map(m => m[1]);
  const seen = {}; const dups = new Set();
  fnNames.forEach(n => { seen[n] = (seen[n] || 0) + 1; if (seen[n] > 1) dups.add(n); });
  record('بدون تابع تکراری در سطح بالا', dups.size === 0, dups.size ? [...dups].join(', ') : '');

  // آیدی‌های تکراری عناصر HTML (به‌جز موارد شناخته‌شده‌ی امن مودال‌ها و آیدی‌های پویا مثل ${...})
  const KNOWN_SAFE_DUP_IDS = new Set(['f_parking', 'f_elevator', 'f_storage', 'f_balcony', 'f_area', 'f_neighborhood', 'f_beds', 'f_notes', 'jpBody']);
  const idMatches = [...html.matchAll(/id="([^"$]+)"/g)].map(m => m[1]).filter(id => !id.includes('${'));
  const idCounts = {};
  idMatches.forEach(id => { idCounts[id] = (idCounts[id] || 0) + 1; });
  const unexpectedDups = Object.keys(idCounts).filter(id => idCounts[id] > 1 && !KNOWN_SAFE_DUP_IDS.has(id));
  record('بدون آیدی تکراری غیرمنتظره', unexpectedDups.length === 0, unexpectedDups.length ? unexpectedDups.join(', ') : '');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------- بخش ۲: بررسی‌های زنده با مرورگر (Playwright) ----------
async function runBrowserChecks() {
  console.log('\n── بررسی‌های زنده با مرورگر ──');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => {
    const t = msg.text();
    if (msg.type() === 'error' && !/403|CORS|ERR_FAILED|Leaflet/i.test(t)) pageErrors.push('CONSOLE: ' + t);
  });

  // دور زدن صفحه‌ی فعال‌سازی لایسنس، مخصوص محیط تست
  await page.addInitScript(() => {
    localStorage.setItem('crm_license_v1', JSON.stringify({
      key: 'TEST', deviceId: 'test-device', lastCheck: Date.now(), expiresAt: null, valid: true
    }));
  });

  await page.goto('file://' + targetFile);
  await page.waitForTimeout(1500);

  // همه‌ی تب‌های اصلی سالم سوییچ می‌کنن
  const tabNames = ['dashboard', 'leads', 'properties', 'matching', 'messenger', 'adtool', 'atlas', 'finance', 'managers', 'contracts', 'reports', 'ai', 'settings', 'tasks'];
  for (const t of tabNames) {
    try { await page.evaluate((name) => window.switchTab(name), t); await page.waitForTimeout(120); }
    catch (e) { pageErrors.push(`TAB(${t}) FAILED: ${e.message}`); }
  }
  record('همه‌ی ۱۴ تب اصلی بدون خطا سوییچ می‌کنن', true);

  // ۴ زیرنمای اطلس
  for (const v of ['regions', 'towers', 'pricer', 'market']) {
    try { await page.evaluate((vv) => window.switchAtlasView(vv), v); await page.waitForTimeout(100); }
    catch (e) { pageErrors.push(`ATLAS VIEW (${v}) FAILED: ${e.message}`); }
  }
  record('هر ۴ زیرنمای اطلس بدون خطا سوییچ می‌کنن', true);

  // --- تست‌های اختصاصیِ باگ‌هایی که قبلاً پیدا و رفع شدن (برای جلوگیری از برگشتشون) ---

  // ۱) باگ تاریخ pmTimeAgo/faDate (v76): نباید برای تاریخ قدیمی خروجی بی‌معنی بده
  try {
    const dateResult = await page.evaluate(() => {
      if (typeof pmTimeAgo !== 'function') return 'NO_FN';
      return pmTimeAgo(Date.now() - 20 * 86400000);
    });
    const ok = dateResult !== 'NO_FN' && !/NaN|undefined/.test(dateResult) && /[۰-۹]/.test(dateResult);
    record('pmTimeAgo برای تاریخ ۲۰ روز پیش خروجی معتبر می‌ده', ok, dateResult);
  } catch (e) { record('pmTimeAgo برای تاریخ ۲۰ روز پیش خروجی معتبر می‌ده', false, e.message); }

  // ۲) فرمت زنده‌ی اعداد فارسی + جداکننده روی فیلدهای مبلغی فایل (v76/v80)
  try {
    await page.evaluate(() => openPropertyForm());
    await page.waitForTimeout(150);
    const formatted = await page.evaluate(() => {
      const el = document.getElementById('f_priceSale');
      if (!el) return 'NO_FIELD';
      el.value = '8700000000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    });
    record('فرمت فارسی+جداکننده روی قیمت فایل کار می‌کنه', formatted === '۸٬۷۰۰٬۰۰۰٬۰۰۰', formatted);
    await page.evaluate(() => { if (typeof closeModal === 'function') closeModal(); });
  } catch (e) { record('فرمت فارسی+جداکننده روی قیمت فایل کار می‌کنه', false, e.message); }

  // ۳) هشدار قیمت خیلی کم (v76)
  try {
    await page.evaluate(() => openPropertyForm());
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      document.getElementById('f_title').value = 'تست';
      document.getElementById('f_area').value = '100';
      document.getElementById('f_priceSale').value = '8700';
    });
    page.evaluate(() => { saveProperty(); });
    await page.waitForTimeout(300);
    const confirmShown = await page.evaluate(() => !!document.querySelector('.crm-confirm-box'));
    record('هشدار قیمت غیرمنطقی هنگام ذخیره فایل نمایش داده می‌شه', confirmShown);
    if (confirmShown) {
      const cancelBtn = await page.$('.crm-confirm-box button.btn-ghost');
      if (cancelBtn) await cancelBtn.click();
    }
    await page.evaluate(() => { if (typeof closeModal === 'function') closeModal(); });
  } catch (e) { record('هشدار قیمت غیرمنطقی هنگام ذخیره فایل نمایش داده می‌شه', false, e.message); }

  // ۴) فیلدهای مبلغی قرارداد — جداکننده + تبدیل به حروف (v80)
  try {
    await page.evaluate(() => window.switchTab('contracts'));
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const el = document.getElementById('cf_remainderA');
      if (!el) return 'NO_FIELD';
      el.value = '500000000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { formatted: el.value, word: document.getElementById('cf_remainderAWord')?.value };
    });
    const ok = r !== 'NO_FIELD' && r.formatted === '۵۰۰٬۰۰۰٬۰۰۰' && r.word === 'پانصد میلیون';
    record('فیلد باقیمانده قرارداد: جداکننده + تبدیل به حروف', ok, JSON.stringify(r));
  } catch (e) { record('فیلد باقیمانده قرارداد: جداکننده + تبدیل به حروف', false, e.message); }

  // ۵) منبع فایل (own/partner/divar) روی کارت فایل رنگ درست می‌گیره (v79)
  try {
    await page.evaluate(() => {
      openPropertyForm();
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      document.getElementById('f_title').value = 'تست منبع';
      document.getElementById('f_area').value = '100';
      document.getElementById('f_priceSale').value = '5000000000';
      if (document.getElementById('f_fileSource')) document.getElementById('f_fileSource').value = 'partner';
    });
    await page.evaluate(() => saveProperty());
    await page.waitForTimeout(250);
    await page.evaluate(() => window.switchTab('properties'));
    await page.waitForTimeout(300);
    const hasPartnerClass = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#propsTable tbody tr'), ...document.querySelectorAll('#propsCardGrid .pmcard')];
      return rows.some(r => r.className.includes('src-partner'));
    });
    record('نشانه‌ی رنگی «منبع فایل: دفتر همکار» روی فایل ظاهر می‌شه', hasPartnerClass);
  } catch (e) { record('نشانه‌ی رنگی «منبع فایل: دفتر همکار» روی فایل ظاهر می‌شه', false, e.message); }

  // ۶) فیلد بودجه‌ی فرم لید بر اساس نوع نیاز عوض می‌شه (v81)
  try {
    await page.evaluate(() => openLeadForm());
    await page.waitForTimeout(150);
    await page.evaluate(() => { document.getElementById('f_need').value = 'rent'; updateLeadNeedFields(); });
    const label = await page.evaluate(() => document.getElementById('f_budgetMinLbl')?.textContent || '');
    record('فیلد بودجه فرم لید برای «رهن و اجاره» به «سقف رهن» تغییر می‌کنه', label.includes('رهن'), label);
    await page.evaluate(() => { if (typeof closeModal === 'function') closeModal(); });
  } catch (e) { record('فیلد بودجه فرم لید برای «رهن و اجاره» به «سقف رهن» تغییر می‌کنه', false, e.message); }

  // ۷) پیام‌رسان: امکان انتخاب «مالک ملک» به‌جای فقط مشتری (v81)
  try {
    await page.evaluate(() => window.switchTab('messenger'));
    await page.waitForTimeout(300);
    const hasToggle = await page.evaluate(() => !!document.getElementById('msg_recipientType'));
    record('پیام‌رسان گزینه‌ی «مالک ملک» رو دارد', hasToggle);
  } catch (e) { record('پیام‌رسان گزینه‌ی «مالک ملک» رو دارد', false, e.message); }

  // ۸) حذف برج/مجتمع در اطلس، اتصال فایل‌های وابسته رو هم واقعاً پاک می‌کنه (v81)
  try {
    const before = await page.evaluate(() => {
      DB.atlasTowers = DB.atlasTowers || [];
      const fake = { id: 999001, name: 'تست حذف برج', buildingType: 'complex', propertyIds: [] };
      DB.atlasTowers.push(fake);
      const prop = DB.properties[0];
      prop.buildingId = fake.id; prop.atlasTowerId = fake.id; prop.buildingType = 'complex';
      saveDB();
      return prop.id;
    });
    page.evaluate((id) => { deleteAtlasTower(id); }, 999001);
    await page.waitForTimeout(300);
    const okBtn = await page.$('.crm-confirm-box button.btn:not(.btn-ghost)');
    if (okBtn) await okBtn.click();
    await page.waitForTimeout(300);
    const after = await page.evaluate((pid) => {
      const p = DB.properties.find(x => x.id === pid);
      return p.buildingId === null && p.atlasTowerId === null;
    }, before);
    record('حذف برج/مجتمع، اتصال فایل‌های وابسته رو هم پاک می‌کنه', after);
  } catch (e) { record('حذف برج/مجتمع، اتصال فایل‌های وابسته رو هم پاک می‌کنه', false, e.message); }

  // ۹) فرهنگ‌لغت خیابان‌های تبریز (فاز ۳) — تشخیص خیابان از متن آگهی
  try {
    const r = await page.evaluate(() => resolveLocation('آپارتمان نوساز خیابان شریعتی طبقه دوم'));
    record('تشخیص خیابان از متن آگهی (فاز ۳ آگهی‌پرداز)', r && r.source === 'dictionary' && r.confidence >= 0.9, JSON.stringify(r));
  } catch (e) { record('تشخیص خیابان از متن آگهی (فاز ۳ آگهی‌پرداز)', false, e.message); }

  if (pageErrors.length) {
    console.log('\n⚠️  خطاهای کنسول/صفحه در طول تست:');
    pageErrors.forEach(e => console.log('   ' + e));
  }
  record('بدون خطای کنسول/صفحه در کل تست', pageErrors.length === 0, pageErrors.length ? `${pageErrors.length} خطا` : '');

  await browser.close();
}

// ---------- اجرای همه‌چیز و خلاصه‌ی نهایی ----------
(async () => {
  runStaticChecks();
  await runBrowserChecks();

  const fails = results.filter(r => !r.ok);
  console.log('\n' + '═'.repeat(50));
  console.log(`نتیجه: ${results.length - fails.length}/${results.length} تست موفق`);
  if (fails.length) {
    console.log(`\n❌ ${fails.length} مورد نیاز به بررسی دارد:`);
    fails.forEach(f => console.log('   - ' + f.name));
    process.exit(1);
  } else {
    console.log('✅ همه‌چیز سالمه — می‌تونید با خیال راحت این نسخه رو منتشر کنید.');
    process.exit(0);
  }
})();
