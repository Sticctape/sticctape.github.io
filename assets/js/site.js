/* ------------------------------------------------------------------
   site.js – unified History API SPA logic
   ------------------------------------------------------------------ */


document.addEventListener('DOMContentLoaded', () => {
  const navBar   = document.querySelector('nav.site-nav');
  const navLinks = navBar.querySelectorAll('a');
  const content  = document.getElementById('content');
  const logo     = document.getElementById('distLogo');
  const divider  = document.getElementById('logoDivider');

  async function loadPage(id) {
    try {
      const resp = await fetch(`pages/${id}.html`);
      if (!resp.ok) throw new Error(`404 for ${id}.html`);
      content.innerHTML = await resp.text();
      if (id === 'cocktails') initCocktailModals();
    } catch (err) {
      content.innerHTML = `<p style="color:#f55">Failed to load page: ${err}</p>`;
    }
  }

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
      const section = link.dataset.section;
      activateSection(section);
      window.location.hash = section;
    })
  );

  window.addEventListener('hashchange', () => {
    const id = window.location.hash.replace('#', '') || 'about';
    activateSection(id);
  });

  function updateSticky() {
    const stuck = navBar.getBoundingClientRect().top <= 0;
    navBar.classList.toggle('stuck', stuck);
    document.getElementById('siteHeroSmall')
        .classList.toggle('show', stuck);
  }
  window.addEventListener('scroll',  updateSticky, { passive:true });
  window.addEventListener('resize',  updateSticky);
  updateSticky();

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
        mImg.src           = card.dataset.img;
        mTitle.textContent = card.dataset.name;
        mIng.innerHTML     = card.dataset.full
                              .split('\n')
                              .map(t => `<li>${t.trim()}</li>`)
                              .join('');
        mInstr.innerHTML   = card.dataset.instructions
                                .replace(/\\n/g, '<br>')
                                .replace(/(?:\r\n|\r|\n)/g, '<br>');
        overlay.classList.add('active');
      })
    );

    closeBtn.onclick = () => overlay.classList.remove('active');
    overlay.onclick  = e => { if (e.target === overlay) overlay.classList.remove('active'); };
  }

  // 🔰 Initial load based on hash (deep linking)
  const first = window.location.hash.replace('#', '') || 'about';
  activateSection(first);
});

    const nav      = document.querySelector('.site-nav');
    const toggle   = document.querySelector('.nav-toggle');
    const sent  = document.getElementById('nav-sentinel');

  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen);
  document.body.classList.toggle('menu-open', isOpen);
  });

  const obs = new IntersectionObserver(
    ([entry]) => nav.classList.toggle('stuck', !entry.isIntersecting),
    {
      rootMargin: `-${nav.offsetHeight}px 0px 0px 0px`
      // once the top of the page has scrolled navHeight past the viewport,
      // entry.isIntersecting becomes false ➜ we add .stuck
    }
  );
  obs.observe(sent);

  /* close drawer when any link is tapped */
document.querySelectorAll('nav.site-nav ul a')
        .forEach(a=>a.addEventListener('click', ()=>{
          nav.classList.remove('open');
          document.body.classList.remove('menu-open');
        }));
