(function () {
  function revealNode(node) {
    if (!node || !node.style) return;
    if (node.style.opacity === '0') node.style.opacity = '1';
    if (node.style.transform) node.style.transform = 'none';
  }

  function reveal() {
    var main = document.getElementById('main');
    if (!main) return;

    main.querySelectorAll(':scope > div[style*="opacity:0"]').forEach(function (node) {
      var isSkeleton = node.querySelector('.animate-shimmer') && !node.querySelector('a[href*="/product/"]');
      if (isSkeleton) node.remove();
      else revealNode(node);
    });

    document.querySelectorAll('div[hidden][id^="S:"]').forEach(function (node) {
      node.removeAttribute('hidden');
      while (node.firstChild) main.appendChild(node.firstChild);
      node.remove();
    });

    main.querySelectorAll(':scope > [style*="opacity"]').forEach(revealNode);
    main.removeAttribute('aria-busy');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reveal);
  } else {
    reveal();
  }
})();
