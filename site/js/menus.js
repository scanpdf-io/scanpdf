// Pop-up menus (the language switcher, the scanner's "more" menu) are
// <details class="menu"> elements, so they open and their links work without
// any script. This adds what <details> lacks: closing on an outside click, on
// Escape, and once something in the menu has been chosen.

const menus = Array.from(document.querySelectorAll('details.menu'));

document.addEventListener('click', (event) => {
  for (const menu of menus) {
    if (!menu.open) continue;
    const inside = menu.contains(event.target);
    const chose = inside && event.target.closest('.menu-list a, .menu-list button');
    if (!inside || chose) menu.open = false;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const menu of menus) {
    if (!menu.open) continue;
    menu.open = false;
    menu.querySelector('summary').focus();
  }
});
