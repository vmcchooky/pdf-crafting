// PDF.js 4.10.38 (S5): bản ESM legacy — module script chạy theo thứ tự tài
// liệu, trước các deferred classic script (utils.js, app.js), nên
// window.pdfjsLib đã sẵn khi app.js chạy.
// S15: tách từ inline <script> trong index.html ra file riêng để CSP
// script-src 'self' cho phép (inline script bị CSP chặn).
import * as pdfjsLib from './vendor/pdf.min.mjs';
window.pdfjsLib = pdfjsLib;
