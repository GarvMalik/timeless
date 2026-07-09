/* Landing page — reveal-on-scroll + footer year. Kept intentionally tiny. */
(function () {
  'use strict';

  var yr = document.getElementById('year');
  if (yr) yr.textContent = new Date().getFullYear();

  var items = document.querySelectorAll('[data-reveal]');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
    return;
  }

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry, i) {
        if (entry.isIntersecting) {
          // gentle stagger for groups revealing together
          setTimeout(function () {
            entry.target.classList.add('in');
          }, (i % 4) * 80);
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
  );

  items.forEach(function (el) { io.observe(el); });
})();
