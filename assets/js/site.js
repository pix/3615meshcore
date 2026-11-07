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

// Bascule 40/80 colonnes : chaque écran montre un seul mode, et choisir 40 ou 80 sur un écran
// bascule tous les écrans à la fois (choix retenu d'une page à l'autre, localStorage) ; l'écran
// cliqué reste sous le pointeur. Sans JavaScript, le premier mode reste affiché.
(function () {
  "use strict";
  var KEY = "mt-cols";
  function pick(fig, mode) {
    var vs = fig.querySelectorAll(".variant"), has = false, i;
    for (i = 0; i < vs.length; i++) if (vs[i].getAttribute("data-mode") === mode) has = true;
    if (!has) return;
    for (i = 0; i < vs.length; i++) vs[i].hidden = vs[i].getAttribute("data-mode") !== mode;
    var bs = fig.querySelectorAll(".modes button[data-mode]");
    for (i = 0; i < bs.length; i++) bs[i].setAttribute("aria-pressed", String(bs[i].getAttribute("data-mode") === mode));
  }
  function pickAll(mode) {
    var figs = document.querySelectorAll(".shot");
    for (var i = 0; i < figs.length; i++) pick(figs[i], mode);
  }
  function fromHash() {   // a link to one mode (#convlist-40) shows every screen in that mode
    var id = decodeURIComponent(location.hash.slice(1));
    var v = id && document.getElementById(id);
    if (v && v.classList.contains("variant")) {
      pickAll(v.getAttribute("data-mode"));
      v.closest(".shot").scrollIntoView();
    }
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest(".modes button[data-mode]") : null;
    if (!b) return;
    var fig = b.closest(".shot"), mode = b.getAttribute("data-mode");
    var top = fig.getBoundingClientRect().top;
    pickAll(mode);
    window.scrollBy(0, fig.getBoundingClientRect().top - top);   // the screens above changed height
    try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode */ }
  });
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
  if (saved === "40" || saved === "80") pickAll(saved);
  fromHash();
  window.addEventListener("hashchange", fromHash);
})();
