// Remplit les champs [data-legal="clé"] à partir de config.js.
// Une valeur vide est affichée en surbrillance « [À COMPLÉTER] ».
(function () {
  var L = window.LEGAL || {};
  var missing = 0;
  document.querySelectorAll("[data-legal]").forEach(function (el) {
    var key = el.getAttribute("data-legal");
    var val = (L[key] || "").toString().trim();
    if (val) {
      if (key === "email") {
        var a = document.createElement("a");
        a.href = "mailto:" + val;
        a.textContent = val;
        el.replaceChildren(a);
      } else {
        el.textContent = val;
      }
    } else {
      el.textContent = "[À COMPLÉTER : " + (el.getAttribute("data-label") || key) + "]";
      el.classList.add("todo");
      missing++;
    }
  });
  var banner = document.getElementById("todo-banner");
  if (banner && missing > 0) {
    banner.hidden = false;
    banner.querySelector("b").textContent = missing;
  }
})();
