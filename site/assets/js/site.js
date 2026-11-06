// 3615 MESHCORE site: text / image toggles for the screen panels, and the text-mode
// animation of the welcome page. Works without it: the text render is the default.
(function () {
  "use strict";
  var KEY = "mt-view";

  function load() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function save(v) {
    try { window.localStorage.setItem(KEY, v); } catch (e) { /* private mode, blocked storage */ }
  }

  function setView(shot, v) {
    shot.setAttribute("data-view", v);
    var bs = shot.querySelectorAll(".views button[data-v]");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-pressed", bs[i].getAttribute("data-v") === v ? "true" : "false");
    if (v === "image") {   // load the picture now, even if it is not in view yet
      var img = shot.querySelector(".iv img[data-src]");
      if (img) { img.src = img.getAttribute("data-src"); img.removeAttribute("data-src"); }
    }
  }

  function setAll(v) {
    var shots = document.querySelectorAll(".shot[data-view]");
    for (var i = 0; i < shots.length; i++) setView(shots[i], v);
    var gs = document.querySelectorAll(".allviews button[data-all]");
    for (var j = 0; j < gs.length; j++) gs[j].setAttribute("aria-pressed", gs[j].getAttribute("data-all") === v ? "true" : "false");
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("button") : null;
    if (!b) return;
    if (b.hasAttribute("data-all")) {
      var v = b.getAttribute("data-all");
      setAll(v);
      save(v);
    } else if (b.hasAttribute("data-v")) {
      var shot = b.closest(".shot");
      if (shot) setView(shot, b.getAttribute("data-v"));
    } else if (b.hasAttribute("data-play")) {
      var a = b.closest(".shot").querySelector(".anim");
      if (a && a._toggle) a._toggle();
    }
  });

  var bars = document.querySelectorAll(".views, .allviews");
  for (var i = 0; i < bars.length; i++) bars[i].hidden = false;
  var saved = load();
  setAll(saved === "image" ? "image" : "text");

  // ---- animations (text view): one .mt per frame, shown in turn
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
    var btn = a.parentNode.parentNode.querySelector("button[data-play]");
    function label() { if (btn) btn.textContent = playing ? "Pause" : "Lecture"; }
    a._toggle = function () { playing = !playing; label(); if (playing) kick(); };
    label();
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        kick();
      }).observe(a);
    } else { visible = true; kick(); }
  })(anims[k]);
})();
