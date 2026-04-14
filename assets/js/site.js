(function () {
  var root = document.documentElement;
  var themeButton = document.querySelector("[data-theme-toggle]");
  var themeLabel = document.querySelector("[data-theme-label]");
  var menuButton = document.querySelector("[data-menu-toggle]");
  var nav = document.querySelector("[data-site-nav]");
  var binaryRain = document.querySelector("[data-binary-rain]");
  var storageKey = "theme-preference";

  function setTheme(nextTheme) {
    root.setAttribute("data-theme", nextTheme);

    if (themeButton) {
      themeButton.setAttribute("aria-pressed", String(nextTheme === "light"));
    }

    if (themeLabel) {
      themeLabel.textContent = nextTheme === "light" ? "Dark mode" : "Light mode";
    }

    try {
      localStorage.setItem(storageKey, nextTheme);
    } catch (error) {}
  }

  function closeMenu() {
    document.body.classList.remove("menu-open");
    if (menuButton) {
      menuButton.setAttribute("aria-expanded", "false");
    }
  }

  var savedTheme = null;

  try {
    savedTheme = localStorage.getItem(storageKey);
  } catch (error) {}

  if (!savedTheme && window.matchMedia("(prefers-color-scheme: light)").matches) {
    savedTheme = "light";
  }

  setTheme(savedTheme || root.getAttribute("data-theme") || "dark");

  if (themeButton) {
    themeButton.addEventListener("click", function () {
      var current = root.getAttribute("data-theme") || "dark";
      setTheme(current === "light" ? "dark" : "light");
    });
  }

  if (menuButton) {
    menuButton.addEventListener("click", function () {
      var isOpen = document.body.classList.toggle("menu-open");
      menuButton.setAttribute("aria-expanded", String(isOpen));
    });
  }

  if (nav) {
    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", closeMenu);
    });
  }

  window.addEventListener("resize", function () {
    if (window.innerWidth > 780) {
      closeMenu();
    }
  });

  if (binaryRain) {
    var dropCount = window.matchMedia("(max-width: 780px)").matches ? 23 : 38;
    var fragment = document.createDocumentFragment();

    for (var index = 0; index < dropCount; index += 1) {
      var bit = document.createElement("span");
      bit.className = "binary-drop";
      bit.textContent = Math.random() < 0.5 ? "0" : "1";
      bit.style.setProperty("--left", (index / dropCount) * 100 + Math.random() * 4 + "%");
      bit.style.setProperty("--delay", -(Math.random() * 18).toFixed(2) + "s");
      bit.style.setProperty("--duration", (12 + Math.random() * 10).toFixed(2) + "s");
      bit.style.setProperty("--drift", (Math.random() * 36 - 18).toFixed(1) + "px");
      bit.style.setProperty("--size", (1 + Math.random() * 1.15).toFixed(2) + "rem");
      bit.style.setProperty("--opacity", (0.7 + Math.random() * 0.2).toFixed(2));
      fragment.appendChild(bit);
    }

    binaryRain.appendChild(fragment);
  }
})();
