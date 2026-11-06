// 3615 MESHCORE : le lecteur d'images des pages animées (rendu texte). Sans JavaScript,
// la dernière image, complète, reste affichée.
(function () {
  "use strict";
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button[data-play]") : null;
    if (!b) return;
    var a = b.closest(".shot").querySelector(".anim");
    if (a && a._toggle) a._toggle();
  });

  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var anims = document.querySelectorAll(".anim");
  for (var k = 0; k < anims.length; k++) (function (a) {
    var frames = a.querySelectorAll(".mt");
    if (frames.length < 2) return;
    var ms = parseInt(a.getAttribute("data-ms"), 10) || 130;
    var hold = parseInt(a.getAttribute("data-hold"), 10) || 3000;
    var n = frames.length - 1, timer = null, visible = false, playing = !still;
    a.classList.add("js");
    function show(i) {
      frames[n].classList.remove("on");
      n = i;
      frames[n].classList.add("on");
    }
    show(still ? frames.length - 1 : 0);
    function tick() {
      timer = null;
      if (!playing || !visible) return;
      var next = (n + 1) % frames.length;
      show(next);
      timer = setTimeout(tick, next === frames.length - 1 ? hold : ms);
    }
    function kick() { if (!timer && playing && visible) timer = setTimeout(tick, ms); }
    var btn = a.closest(".shot").querySelector("button[data-play]");
    function label() { if (btn) { btn.textContent = playing ? "Pause" : "Lecture"; btn.hidden = false; } }
    a._toggle = function () { playing = !playing; label(); if (playing) kick(); };
    label();
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) { visible = es[0].isIntersecting; kick(); }).observe(a);
    } else { visible = true; kick(); }
  })(anims[k]);
})();
