/* Anti-clickjacking. GitHub Pages can't send X-Frame-Options, and a meta CSP
   ignores frame-ancestors, so we bust out of any frame in script instead.
   Loaded synchronously in <head> before anything renders. */
(function () {
  'use strict';
  if (window.top !== window.self) {
    try {
      window.top.location = window.self.location.href;
    } catch (e) {
      // cross-origin framer blocked the redirect — hide the page entirely
      document.documentElement.style.display = 'none';
      window.stop && window.stop();
    }
  }
})();
