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

  function paypalOnly() {
    var labels = ['Pay with', 'We accept'];
    labels.forEach(function (label) {
      var nodes = Array.prototype.slice.call(document.querySelectorAll('span'));
      nodes.forEach(function (span) {
        if (span.children.length || span.textContent.trim() !== label) return;
        var group = span.parentElement;
        if (!group) return;
        group.textContent = '';
        var text = document.createElement('span');
        text.className = 'text-xs text-faint';
        text.textContent = label;
        var paypal = document.createElement('span');
        paypal.setAttribute('role', 'img');
        paypal.setAttribute('aria-label', 'PayPal');
        paypal.className = 'grid h-7 min-w-[4.2rem] place-items-center rounded-md border border-line bg-white/[0.03] px-2 font-sans text-[0.72rem] font-black italic tracking-tight text-white';
        paypal.textContent = 'PayPal';
        group.append(text, paypal);
      });
    });

    Array.prototype.slice.call(document.querySelectorAll('span')).forEach(function (span) {
      if (span.children.length) return;
      var value = span.textContent.trim();
      if (/^Instant delivery$/i.test(value)) span.textContent = 'Discord delivery';
      else if (/^INSTANT$/i.test(value)) span.textContent = 'LIVRAISON';
      else if (/^DELIVERY$/i.test(value)) span.textContent = 'DISCORD';
    });

    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName)) continue;
      var text = node.nodeValue.trim();
      if (/^Instant delivery$/i.test(text)) node.nodeValue = 'Discord delivery';
    }
  }

  function init() {
    reveal();
    paypalOnly();
    window.setTimeout(paypalOnly, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
