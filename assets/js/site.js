/* ------------------------------------------------------------------
   site.js – shell logic for the hybrid SPA
   ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  /* --------- refs --------- */
  const navBar   = document.querySelector('nav.site-nav');
  const navLinks = navBar.querySelectorAll('a');
  const content  = document.getElementById('content');      // <main id="content">
  const logo     = document.getElementById('distLogo');
  const divider  = document.getElementById('logoDivider');

  /* --------- fetch + inject partial --------- */
  async function loadPage(id) {
    try {
      const resp = await fetch(`pages/${id}.html`);
      if (!resp.ok) throw new Error(`404 for ${id}.html`);
      content.innerHTML = await resp.text();

      // run section-specific init if needed
      if (id === 'cocktails') initCocktailModals();
    } catch (err) {
      content.innerHTML = `<p style="color:#f55">Failed to load page: ${err}</p>`;
    }
  }

  /* --------- nav handling --------- */
  function activateSection(id) {
    navLinks.forEach(l => l.classList.toggle('active', l.dataset.section === id));
    const show = id === 'cocktails';
    logo.classList.toggle('show', show);
    divider.classList.toggle('show', show);
    loadPage(id);
  }

  navLinks.forEach(link =>
    link.addEventListener('click', e => {
      e.preventDefault();
      activateSection(link.dataset.section);
      history.pushState({}, '', `#${link.dataset.section}`);   // update address bar
    })
  );

  /* --------- sticky opacity --------- */
  window.addEventListener('scroll', () =>
    navBar.classList.toggle('stuck', window.scrollY > 0)
  );

  /* --------- modal logic for cocktails page --------- */
  function initCocktailModals() {
    const cards    = document.querySelectorAll('.cocktail-card');
    const overlay  = document.getElementById('modalOverlay');
    const mImg     = document.getElementById('modalImg');
    const mTitle   = document.getElementById('modalTitle');
    const mIng     = document.getElementById('modalIngredients');
    const mInstr   = document.getElementById('modalInstructions');
    const closeBtn = document.getElementById('closeBtn');

    cards.forEach(card =>
      card.addEventListener('click', () => {
        mImg.src         = card.dataset.img;
        mTitle.textContent = card.dataset.name;
        mIng.innerHTML     = card.dataset.full
                               .split('\n')
                               .map(t => `<li>${t.trim()}</li>`)
                               .join('');
        mInstr.textContent = card.dataset.instructions;
        overlay.classList.add('active');
      })
    );

    closeBtn.onclick = () => overlay.classList.remove('active');
    overlay.onclick  = e => { if (e.target === overlay) overlay.classList.remove('active'); };
  }

  /* --------- initial load (deep-link aware) --------- */
  const first = location.hash.replace('#', '') || 'about';
  activateSection(first);
});
