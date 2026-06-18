/* Smooth reveal-on-scroll. Degrades safely: if this script doesn't run,
   the .reveal class is never added, so all content stays visible. */
(function () {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var sel = "[data-reveal], .section-head, .trust, .tools > a, .steps > .st, .model, .cta, .panel, .stepc, .econ, .pilot, .photo-band, .card";
  var els = [].slice.call(document.querySelectorAll(sel));
  els.forEach(function (el) { el.classList.add("reveal"); });
  if (!("IntersectionObserver" in window)) { els.forEach(function (el) { el.classList.add("in"); }); return; }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        var sibs = [].slice.call(e.target.parentNode.children).filter(function (c) { return c.classList.contains("reveal"); });
        var i = Math.max(0, sibs.indexOf(e.target));
        e.target.style.transitionDelay = Math.min(i * 70, 280) + "ms";
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -7% 0px" });
  els.forEach(function (el) { io.observe(el); });
})();
