// Lazy loader for the vendored OpenCV.js build. The script is ~10MB, so it is
// injected after first paint; uploads queue on cvReady() until the WASM
// runtime is initialized.
//
// CAUTION: Emscripten-era builds (like the 4.9 docs build) expose a fake
// `then` on the Module object; `await`-ing it re-resolves forever and locks
// the main thread in a microtask loop (emscripten#5820). Never await the
// module — only a real Promise. Rely on onRuntimeInitialized instead.

let promise = null;

export function cvReady() {
  if (promise) return promise;
  promise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/opencv.js';
    s.async = true;
    s.onerror = () => reject(new Error('Failed to load vendor/opencv.js'));
    // Promise resolution adopts thenables, so resolving with the module
    // would also loop on the fake `then` — strip it first.
    const finish = (m) => {
      if (m && typeof m.then === 'function' && !(m instanceof Promise)) {
        try {
          delete m.then;
        } catch (_) {
          /* non-configurable; nothing we can do */
        }
      }
      resolve(m);
    };
    s.onload = () => {
      const cv = window.cv;
      if (!cv) {
        reject(new Error('OpenCV.js loaded but `cv` global is missing'));
        return;
      }
      if (cv instanceof Promise) {
        // Modern builds return a real Promise of the module.
        cv.then((m) => {
          window.cv = m;
          finish(m);
        }, reject);
        return;
      }
      if (cv.Mat || cv.calledRun) {
        finish(cv);
        return;
      }
      const prev = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        if (prev) prev();
        finish(cv);
      };
    };
    document.head.appendChild(s);
  });
  return promise;
}
