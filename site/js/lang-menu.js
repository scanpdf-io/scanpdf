// The language switcher is a <details> element, so it opens and its links
// work without any script. This only adds the two things <details> lacks:
// closing on an outside click and on Escape.

const menu = document.querySelector('.lang-menu');

if (menu) {
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary').focus();
  });
}
