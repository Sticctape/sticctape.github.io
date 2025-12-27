/* ------------------------------------------------------------------
   site.js – unified History API SPA logic
   ------------------------------------------------------------------ */

// STATIC PASSWORDS
const STAFF_PASSWORD = 'iLoveCocktails'; // staff / members (full recipe access)
const CUSTOMER_PASSWORD = 'OrderUp!';   // customers who can place orders

// Global cooldown tracking for order submissions
let lastOrderTime = 0;
const ORDER_COOLDOWN_MS = 60000; // 60 seconds

document.addEventListener('DOMContentLoaded', () => {
  const navBar   = document.querySelector('nav.site-nav');
  const navLinks = navBar.querySelectorAll('a[data-section]');
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
    const orderBtn = document.getElementById('orderBtn');
    const modalEl = overlay.querySelector('.modal');
    const orderPanel = document.getElementById('orderPanel');
    const orderName = document.getElementById('orderName');
    const orderError = document.getElementById('orderError');
    const submitOrder = document.getElementById('submitOrder');
    const cancelOrder = document.getElementById('cancelOrder');

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
        const isStaff = localStorage.getItem('isStaff') === 'true';
        const isCustomer = localStorage.getItem('isCustomer') === 'true';

        // Load recipe data from recipes.json (ingredients + instructions)
        const recipes = await loadRecipes();
        const id = card.dataset.id;
        const recipe = (id && recipes && recipes[id]) ? recipes[id] : null;

        // Modal title & image come from JSON when available
        mImg.src = (recipe && recipe.img) || card.dataset.img || '';
        mTitle.textContent = (recipe && recipe.name) || card.dataset.name || '';

        // Ingredients: members see `full`, non-members see `clean` (fallback to dataset)
        const ingredientData = isStaff
                  ? (recipe && recipe.full) || card.dataset.clean || ''
                  : (recipe && recipe.clean) || card.dataset.clean || '';
        mIng.innerHTML = ingredientData
                            .split('\n')
                            .map(t => `<li>${t.trim()}</li>`)
                            .join('');

        // Instructions: members see the recipe.instructions from JSON; non-members get a login prompt
        if (isStaff) {
          const instr = (recipe && recipe.instructions) || '';
          mInstr.innerHTML = instr
                                .replace(/(?:\r\n|\r|\n)/g, '<br>');
        } else {
          mInstr.innerHTML = '<p style="font-style: italic; color: #aaa;">Login to view detailed measurements and instructions.</p>';
        }

        // show/hide order button for customers and staff
        const orderBtn = document.getElementById('orderBtn');
        if (orderBtn) orderBtn.classList.toggle('is-hidden', !(isCustomer || isStaff));

        overlay.classList.add('active');
      })
    );

    // Toggle image expansion on click
    mImg.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('Image clicked, toggling expanded class');
      mImg.classList.toggle('expanded');
    }, true); // use capture phase to ensure this fires

    // Reset image size and order panel when modal closes
    const resetModal = () => {
      mImg.classList.remove('expanded');
      overlay.classList.remove('active');
      try {
        if (modalEl) modalEl.classList.remove('show-order');
        if (orderName) orderName.value = '';
        if (orderError) orderError.classList.add('is-hidden');
        if (submitOrder) { submitOrder.disabled = false; submitOrder.textContent = 'Submit Order'; }
      } catch (e) { /* ignore */ }
    };

    // Order button: open order panel (slide left)
    if (orderBtn && modalEl && orderPanel) {
      orderBtn.addEventListener('click', () => {
        // prevent double-tap spam
        orderBtn.disabled = true;
        modalEl.classList.add('show-order');
        orderPanel.setAttribute('aria-hidden', 'false');
        // focus input after a tiny delay so it's visible
        setTimeout(() => {
          if (orderName) orderName.focus();
          orderBtn.disabled = false;
        }, 250);
      });
    }

    // Cancel / back from order panel
    if (cancelOrder && modalEl) {
      cancelOrder.addEventListener('click', () => {
        modalEl.classList.remove('show-order');
        if (orderName) orderName.value = '';
        if (orderError) orderError.classList.add('is-hidden');
      });
    }

    // Submit order (with global 30s cooldown to prevent rapid repeats)
    if (submitOrder) {
      submitOrder.addEventListener('click', async () => {
        // Check global cooldown (only for customers, not staff)
        const isStaff = localStorage.getItem('isStaff') === 'true';
        const now = Date.now();
        if (!isStaff && now - lastOrderTime < ORDER_COOLDOWN_MS) {
          const remaining = Math.ceil((ORDER_COOLDOWN_MS - (now - lastOrderTime)) / 1000);
          if (orderError) {
            orderError.textContent = `Please wait ${remaining}s before placing another order`;
            orderError.classList.remove('is-hidden');
          }
          return;
        }
        
        const name = (orderName && orderName.value || '').trim();
        if (!name) {
          if (orderError) {
            orderError.textContent = 'Please enter a name';
            orderError.classList.remove('is-hidden');
          }
          return;
        }
        if (orderError) orderError.classList.add('is-hidden');
        
        // Get Turnstile token (only for customers, not staff)
        let turnstileToken = null;
        if (!isStaff && typeof turnstile !== 'undefined') {
          turnstileToken = turnstile.getResponse();
          if (!turnstileToken) {
            if (orderError) {
              orderError.textContent = 'Please complete the Turnstile verification';
              orderError.classList.remove('is-hidden');
            }
            return;
          }
        }
        
        // Disable button during submission
        submitOrder.disabled = true;
        
        // Prepare order data (matching worker expectations)
        const orderData = {
          drink: (mTitle && mTitle.textContent) || '',
          qty: 1,
          notes: `Customer: ${name}`,
          turnstileToken
        };
        
        try {
          // Send to Cloudflare Worker
          const resp = await fetch('https://streeter.cc/api/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData)
          });
          
          if (!resp.ok) {
            throw new Error(`Server error: ${resp.statusText}`);
          }
          
          // Success: store locally and update UI
          const existing = JSON.parse(localStorage.getItem('orders') || '[]');
          existing.push({ id: Date.now(), name, recipe: orderData.drink, ts: new Date().toISOString() });
          localStorage.setItem('orders', JSON.stringify(existing));
          updateCartCount();
          
          if (typeof showAuthBanner === 'function') showAuthBanner(`Order placed for ${name}`);
          
          // Update global cooldown (only for customers) and close modal
          if (!isStaff) lastOrderTime = now;
          
          // Reset Turnstile
          if (!isStaff && typeof turnstile !== 'undefined') {
            turnstile.reset();
          }
          
          resetModal();
        } catch (e) {
          console.error('Order submission error:', e);
          if (orderError) {
            orderError.textContent = `Error: ${e.message}`;
            orderError.classList.remove('is-hidden');
          }
        } finally {
          submitOrder.disabled = false;
        }
      });
    }

    closeBtn.onclick = resetModal;
    overlay.onclick  = e => { if (e.target === overlay) resetModal(); };
  }

  // 🔰 Initial load based on hash (deep linking)
  const first = window.location.hash.replace('#', '') || 'about';
  activateSection(first);
});

// Helper: update cart count badge from localStorage
function updateCartCount() {
  try {
    const cartCount = document.getElementById('cartCount');
    if (cartCount) {
      const orders = JSON.parse(localStorage.getItem('orders') || '[]');
      cartCount.textContent = orders.length ? String(orders.length) : '0';
    }
  } catch (e) { /* ignore */ }
}

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

    if (password === STAFF_PASSWORD) {
      // Staff (member) login: full recipe access
      loginError.classList.add('is-hidden');
      localStorage.setItem('isStaff', 'true');
      updateLoginUI();
      loginOverlay.classList.remove('active');
      loginForm.reset();
      if (typeof showAuthBanner === 'function') showAuthBanner('Staff authentication');
      // close mobile nav if it's open (same behavior as selecting a page)
      try {
        if (nav && nav.classList.contains('open')) {
          nav.classList.remove('open');
          document.body.classList.remove('menu-open');
          if (toggle && typeof toggle.setAttribute === 'function') toggle.setAttribute('aria-expanded', 'false');
        }
      } catch (e) { /* silent */ }
    } else if (password === CUSTOMER_PASSWORD) {
      // Customer login: enable ordering UI
      loginError.classList.add('is-hidden');
      localStorage.setItem('isCustomer', 'true');
      // update UI immediately
      updateLoginUI();
      // reveal order button if modal is currently present
      try {
        const orderBtnNow = document.getElementById('orderBtn');
        if (orderBtnNow) orderBtnNow.classList.remove('is-hidden');
      } catch (e) {}
      loginOverlay.classList.remove('active');
      loginForm.reset();
      if (typeof showAuthBanner === 'function') showAuthBanner('Customer mode enabled');
      // close mobile nav if it's open (same behavior as selecting a page)
      try {
        if (nav && nav.classList.contains('open')) {
          nav.classList.remove('open');
          document.body.classList.remove('menu-open');
          if (toggle && typeof toggle.setAttribute === 'function') toggle.setAttribute('aria-expanded', 'false');
        }
      } catch (e) { /* silent */ }
    } else {
      // Login failed
      loginError.textContent = 'Incorrect password';
      loginError.classList.remove('is-hidden');
    }
  });

  // Update UI based on login status (staff or customer)
  function updateLoginUI() {
    const isStaff = localStorage.getItem('isStaff') === 'true';
    const isCustomer = localStorage.getItem('isCustomer') === 'true';
    const isLoggedIn = isStaff || isCustomer;
    loginBtn.classList.toggle('is-hidden', isLoggedIn);
    logoutBtn.classList.toggle('is-hidden', !isLoggedIn);
    document.body.classList.toggle('is-staff', isStaff);
    document.body.classList.toggle('is-customer', isCustomer);

    // show cart for customers and staff, update count
    try {
      const cartWrap = document.getElementById('navCartWrap');
      if (cartWrap) cartWrap.classList.toggle('is-hidden', !(isCustomer || isStaff));
      updateCartCount(); // use helper to update badge
    } catch (e) { /* ignore */ }
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

  // Logout handler (clears staff and customer flags)
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('isStaff');
    localStorage.removeItem('isCustomer');
    updateLoginUI();
  });

  // Check login status on page load
  updateLoginUI();

  // Nav cart click behavior (placeholder: shows summary banner)
  try {
    const navCartWrap = document.getElementById('navCartWrap');
    const cartCountEl = document.getElementById('cartCount');
    const cartFlyout = document.getElementById('cartFlyout');
    const cartFlyoutOverlay = document.getElementById('cartFlyoutOverlay');
    const cartFlyoutBody = document.getElementById('cartFlyoutBody');
    const closeCartBtn = document.getElementById('closeCartBtn');

    // Open cart flyout
    if (navCartWrap && cartFlyout && cartFlyoutOverlay) {
      navCartWrap.addEventListener('click', () => {
        cartFlyout.classList.remove('is-hidden');
        cartFlyout.classList.add('show');
        cartFlyoutOverlay.classList.remove('is-hidden');
        cartFlyoutOverlay.classList.add('show');
        // populate cart items
        renderCartItems();
      });
    }

    // Close cart flyout
    const closeCartPanel = () => {
      if (cartFlyout) cartFlyout.classList.remove('show');
      if (cartFlyoutOverlay) {
        cartFlyoutOverlay.classList.remove('show');
        setTimeout(() => cartFlyoutOverlay.classList.add('is-hidden'), 250);
      }
    };
    if (closeCartBtn) closeCartBtn.addEventListener('click', closeCartPanel);
    if (cartFlyoutOverlay) cartFlyoutOverlay.addEventListener('click', closeCartPanel);

    // Render cart items from localStorage
    function renderCartItems() {
      if (!cartFlyoutBody) return;
      const orders = JSON.parse(localStorage.getItem('orders') || '[]');
      if (orders.length === 0) {
        cartFlyoutBody.innerHTML = '<p class="cart-empty">No orders yet</p>';
        return;
      }
      cartFlyoutBody.innerHTML = orders.map((order, idx) => `
        <div class="cart-item">
          <div class="cart-item-info">
            <p class="recipe">${order.recipe}</p>
            <p class="name">For: ${order.name}</p>
          </div>
          <button class="cart-item-remove" data-order-id="${order.id}" type="button">Remove</button>
        </div>
      `).join('');
      // add remove button handlers
      cartFlyoutBody.querySelectorAll('.cart-item-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const orderId = parseInt(e.target.dataset.orderId);
          const filtered = orders.filter(o => o.id !== orderId);
          localStorage.setItem('orders', JSON.stringify(filtered));
          updateLoginUI(); // refresh cart count
          renderCartItems(); // re-render
        });
      });
    }
  } catch (e) { /* ignore */ }
