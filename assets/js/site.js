/* ------------------------------------------------------------------
   site.js – unified History API SPA logic
   ------------------------------------------------------------------ */

// STATIC PASSWORD - If you found this, I don't care
const MEMBER_PASSWORD = 'iLoveCocktails';

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
  // cache for full recipes loaded from assets/data/recipes.json
  let recipesCache = null;
  let categoriesCache = null;

  function initCocktailModals() {
    const cards    = document.querySelectorAll('.cocktail-card');
    const overlay  = document.getElementById('modalOverlay');
    const mImg     = document.getElementById('modalImg');
    const mTitle   = document.getElementById('modalTitle');
    const mIng     = document.getElementById('modalIngredients');
    const mInstr   = document.getElementById('modalInstructions');
    const closeBtn = document.getElementById('closeBtn');

    // helper to load recipes.json once
    async function loadRecipes() {
      if (recipesCache) return recipesCache;
      try {
        const resp = await fetch('assets/data/recipes.json');
        if (!resp.ok) throw new Error('Failed to load recipes.json');
        const data = await resp.json();
        // support new structure: { categories: {...}, recipes: { ... } }
        if (data && data.recipes) {
          recipesCache = data.recipes;
          categoriesCache = data.categories || {};
        } else {
          // fallback to old flat map
          recipesCache = data || {};
          categoriesCache = {};
        }
        return recipesCache;
      } catch (err) {
        console.warn('Could not load recipes.json:', err);
        recipesCache = {};
        categoriesCache = {};
        return recipesCache;
      }
    }

    // populate visible cards with JSON data (name, short ingredients, taste, image)
    loadRecipes().then(recipes => {
      cards.forEach(card => {
        const id = card.dataset.id;
        const r = id && recipes && recipes[id] ? recipes[id] : null;
        if (!r) return;
        const titleEl = card.querySelector('h3');
        if (titleEl) titleEl.textContent = r.name;
        const ingEl = card.querySelector('.ingredients');
        if (ingEl) ingEl.textContent = r.ingredients;
        const tasteEl = card.querySelector('.taste');
        if (tasteEl) tasteEl.textContent = r.taste;
        // keep dataset in sync for any code that still reads it
        card.dataset.img = r.img;
        card.dataset.name = r.name;
      });
    });

    cards.forEach(card =>
      card.addEventListener('click', async () => {
        const isMember = localStorage.getItem('isMember') === 'true';

        // Load recipe data from recipes.json (ingredients + instructions)
        const recipes = await loadRecipes();
        const id = card.dataset.id;
        const recipe = (id && recipes && recipes[id]) ? recipes[id] : null;

        // Modal title & image come from JSON when available
        mImg.src = (recipe && recipe.img) || card.dataset.img || '';
        mTitle.textContent = (recipe && recipe.name) || card.dataset.name || '';

        // Ingredients: members see `full`, non-members see `clean` (fallback to dataset)
        const ingredientData = isMember
                              ? (recipe && recipe.full) || card.dataset.clean || ''
                              : (recipe && recipe.clean) || card.dataset.clean || '';
        mIng.innerHTML = ingredientData
                            .split('\n')
                            .map(t => `<li>${t.trim()}</li>`)
                            .join('');

        // Instructions: members see the recipe.instructions from JSON; non-members get a login prompt
        if (isMember) {
          const instr = (recipe && recipe.instructions) || '';
          mInstr.innerHTML = instr
                                .replace(/(?:\r\n|\r|\n)/g, '<br>');
        } else {
          mInstr.innerHTML = '<p style="font-style: italic; color: #aaa;">Login to view detailed measurements and instructions.</p>';
        }

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

  // LOGIN / LOGOUT HANDLERS
  const loginBtn = document.getElementById('navLoginBtn');
  const logoutBtn = document.getElementById('navLogoutBtn');
  const loginForm = document.getElementById('loginForm');
  const loginOverlay = document.getElementById('loginOverlay');
  const loginCloseBtn = document.getElementById('loginCloseBtn');
  const loginError = document.getElementById('loginError');
  const loginPassword = document.getElementById('loginPassword');

  // Show login modal when clicking login button
  loginBtn.addEventListener('click', () => {
    loginOverlay.classList.add('active');
    loginPassword.focus();
  });

  // Close login modal
  loginCloseBtn.addEventListener('click', () => {
    loginOverlay.classList.remove('active');
    loginForm.reset();
    loginError.classList.add('is-hidden');
  });

  // Close on overlay click
  loginOverlay.addEventListener('click', e => {
    if (e.target === loginOverlay) {
      loginOverlay.classList.remove('active');
      loginForm.reset();
      loginError.classList.add('is-hidden');
    }
  });

  // Handle login form submission
  loginForm.addEventListener('submit', e => {
    e.preventDefault();
    const password = loginPassword.value;

    if (password === MEMBER_PASSWORD) {
      // Login successful
      loginError.classList.add('is-hidden');
      localStorage.setItem('isMember', 'true');
      updateLoginUI();
      loginOverlay.classList.remove('active');
      loginForm.reset();
      // show temporary success banner
      if (typeof showAuthBanner === 'function') showAuthBanner('Successful authentication');
    } else {
      // Login failed
      loginError.textContent = 'Incorrect password';
      loginError.classList.remove('is-hidden');
    }
  });

  // Update UI based on login status
  function updateLoginUI() {
    const isMember = localStorage.getItem('isMember') === 'true';
    loginBtn.classList.toggle('is-hidden', isMember);
    logoutBtn.classList.toggle('is-hidden', !isMember);
    document.body.classList.toggle('is-member', isMember);
  }

  // Show a temporary auth banner message (text) — dismisses after timeout
  function showAuthBanner(text, ms = 2600) {
    const banner = document.getElementById('authBanner');
    const msg = document.getElementById('authBannerMsg');
    if (!banner || !msg) return;
    msg.textContent = text;
    banner.classList.remove('is-hidden');
    // trigger show animation
    requestAnimationFrame(() => banner.classList.add('show'));
    // hide after timeout
    clearTimeout(banner._hideTimer);
    banner._hideTimer = setTimeout(() => {
      banner.classList.remove('show');
      // after transition remove hidden to keep DOM tidy
      setTimeout(() => banner.classList.add('is-hidden'), 300);
    }, ms);
  }

  // Logout handler
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('isMember');
    updateLoginUI();
  });

  // Check login status on page load
  updateLoginUI();
