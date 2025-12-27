/* ------------------------------------------------------------------
   site.js – unified History API SPA logic
   ------------------------------------------------------------------ */

// Global cooldown tracking for order submissions
let lastOrderTime = 0;
const ORDER_COOLDOWN_MS = 60000; // 60 seconds
// Global polling for order status updates
let statusPollingInterval = null;
// Track order statuses for notification purposes
let previousOrderStatuses = {};
document.addEventListener('DOMContentLoaded', () => {
  const navBar   = document.querySelector('nav.site-nav');
  const navLinks = navBar.querySelectorAll('a[data-section]');
  const content  = document.getElementById('content');
  const logo     = document.getElementById('distLogo');
  const divider  = document.getElementById('logoDivider');

  async function loadPage(id) {
    try {
      // Cleanup previous page if it had cleanup function
      if (window.cleanupStaffOrders && typeof window.cleanupStaffOrders === 'function') {
        window.cleanupStaffOrders();
      }
      
      const resp = await fetch(`pages/${id}.html`);
      if (!resp.ok) throw new Error(`404 for ${id}.html`);
      content.innerHTML = await resp.text();
      if (id === 'cocktails') initCocktailModals();
      
      // Re-execute scripts in loaded content
      const scripts = content.querySelectorAll('script');
      scripts.forEach(script => {
        const newScript = document.createElement('script');
        newScript.textContent = script.textContent;
        script.parentNode.replaceChild(newScript, script);
      });
      
      // For staff-orders page, ensure the initial load happens
      if (id === 'staff-orders') {
        // Re-setup filters and load orders
        if (typeof window.setupFilterButtons === 'function') {
          setTimeout(() => {
            window.setupFilterButtons();
          }, 0);
        }
        if (typeof window.setupResetButton === 'function') {
          setTimeout(() => {
            window.setupResetButton();
          }, 0);
        }
        if (typeof window.setupDeletePickedUpButton === 'function') {
          setTimeout(() => {
            window.setupDeletePickedUpButton();
          }, 0);
        }
        if (typeof window.loadStaffOrders === 'function') {
          setTimeout(() => {
            window.loadStaffOrders();
          }, 0);
        }
      }
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
          mInstr.innerHTML = '<p style="font-style: italic; color: #aaa;">Contact me to view detailed measurements and instructions.</p>';
        }

        // show/hide order button for customers and staff
        const orderBtn = document.getElementById('orderBtn');
        if (orderBtn) orderBtn.classList.toggle('is-hidden', !(isCustomer || isStaff));

        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
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
      document.body.style.overflow = '';
      try {
        if (modalEl) modalEl.classList.remove('show-order');
        if (orderName) orderName.value = '';
        const orderNotes = document.getElementById('orderNotes');
        if (orderNotes) orderNotes.value = '';
        const noteCount = document.getElementById('noteCount');
        if (noteCount) noteCount.textContent = '0/120';
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

    // Character counter for notes field
    const orderNotes = document.getElementById('orderNotes');
    const noteCount = document.getElementById('noteCount');
    if (orderNotes && noteCount) {
      orderNotes.addEventListener('input', () => {
        noteCount.textContent = `${orderNotes.value.length}/120`;
      });
    }
    // Submit order (with global 30s cooldown to prevent rapid repeats)
    if (submitOrder) {
      // Clone to remove any old listeners
      const newSubmitOrder = submitOrder.cloneNode(true);
      submitOrder.parentNode.replaceChild(newSubmitOrder, submitOrder);
      
      newSubmitOrder.addEventListener('click', async () => {
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
            orderError.textContent = 'Please enter a name for the order';
            orderError.classList.remove('is-hidden');
          }
          return;
        }
        if (orderError) orderError.classList.add('is-hidden');
        
        // Disable button during submission
        newSubmitOrder.disabled = true;
        
        // Prepare order data (matching worker expectations)
        const orderNotes = document.getElementById('orderNotes');
        const orderData = {
          name,
          drink: (mTitle && mTitle.textContent) || '',
          qty: 1,
          notes: (orderNotes && orderNotes.value || '').trim()
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
          
          const responseData = await resp.json();
          const orderId = responseData.orderId;
          
          // Success: store locally with orderId and update UI
          const existing = JSON.parse(localStorage.getItem('orders') || '[]');
          existing.push({ 
            id: orderId, 
            name, 
            recipe: orderData.drink, 
            status: 'Received',
            ts: new Date().toISOString() 
          });
          localStorage.setItem('orders', JSON.stringify(existing));
          updateCartCount();
          
          // Start polling for status updates
          startStatusPolling();
          
          if (typeof showAuthBanner === 'function') showAuthBanner(`Order placed for ${name}`);
          
          // Update global cooldown (only for customers) and close modal
          if (!isStaff) lastOrderTime = now;
          
          resetModal();
        } catch (e) {
          console.error('Order submission error:', e);
          if (orderError) {
            orderError.textContent = `Error: ${e.message}`;
            orderError.classList.remove('is-hidden');
          }
        } finally {
          newSubmitOrder.disabled = false;
        }
      });
    }

    closeBtn.onclick = resetModal;
    overlay.onclick  = e => { if (e.target === overlay) resetModal(); };
  }

  // Request notification permission for order ready alerts
  requestNotificationPermission();

  // Register Service Worker for background notifications on mobile
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('assets/js/sw.js').then(reg => {
      console.log('Service Worker registered for notifications');
    }).catch(err => {
      console.log('Service Worker registration failed:', err);
    });
  }

  // 🔰 Initial load based on hash (deep linking)
  const first = window.location.hash.replace('#', '') || 'about';
  activateSection(first);
});

// Helper: update cart count badge from localStorage
function updateCartCount() {
  try {
    const orders = JSON.parse(localStorage.getItem('orders') || '[]');
    const count = orders.length;
    
    // Update desktop cart count
    const cartCount = document.getElementById('cartCount');
    if (cartCount) {
      if (count === 0) {
        cartCount.classList.add('is-hidden');
      } else {
        cartCount.classList.remove('is-hidden');
        cartCount.textContent = String(count);
      }
    }
    
    // Update mobile cart count
    const mobileCartBadges = document.querySelectorAll('.nav-cart-mobile .cart-count');
    mobileCartBadges.forEach(badge => {
      if (count === 0) {
        badge.classList.add('is-hidden');
      } else {
        badge.classList.remove('is-hidden');
        badge.textContent = String(count);
      }
    });
  } catch (e) { /* ignore */ }
}

// Request permission for notifications (call once on page load)
function requestNotificationPermission() {
  if (!('Notification' in window)) {
    console.log('This browser does not support notifications');
    return;
  }

  if (Notification.permission === 'granted') {
    return; // Already granted
  }

  if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        console.log('Notification permission granted');
      }
    });
  }
}

// Send notification when order is ready
function sendOrderNotification(order) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  // Add vibration on mobile devices
  if ('vibrate' in navigator) {
    navigator.vibrate([200, 100, 200]); // Vibration pattern: 200ms, pause 100ms, 200ms
  }

  const notification = new Notification('🥃🍸 Order Ready!', {
    body: `${order.name}'s ${order.recipe} is ready for pickup!`,
    icon: 'assets/100px_StreeterDistilleryLogoW.png',
    tag: `order-${order.id}`,
    requireInteraction: true,
    badge: 'assets/100px_StreeterDistilleryLogoW.png'
  });

  // Click notification to open cart
  notification.addEventListener('click', () => {
    window.focus();
    const cartIcon = document.getElementById('navCart') || document.querySelector('.nav-cart');
    if (cartIcon) {
      cartIcon.click();
    }
  });
}

// Poll for order status updates every 10 seconds (only when orders exist)
async function pollOrderStatuses() {
  const orders = JSON.parse(localStorage.getItem('orders') || '[]');
  if (orders.length === 0) {
    stopStatusPolling();
    return;
  }

  let statusesChanged = false;
  const ordersToKeep = [];

  for (const order of orders) {
    try {
      const resp = await fetch(`https://streeter.cc/api/orders/${order.id}`);
      if (resp.ok) {
        const data = await resp.json();
        
        // Check if status changed
        if (order.status !== data.status) {
          const oldStatus = order.status;
          order.status = data.status;
          statusesChanged = true;
          
          // Send notification if order became "Ready"
          if (data.status === 'Ready' && oldStatus !== 'Ready') {
            sendOrderNotification(order);
          }
        }
        ordersToKeep.push(order);
      } else {
        // Order no longer exists on server (404 or other error), remove from cart
        console.log(`Order ${order.id} no longer exists, removing from cart`);
        statusesChanged = true;
      }
    } catch (e) {
      console.warn(`Failed to fetch status for order ${order.id}:`, e);
      // On network error, keep the order (it might be a temporary issue)
      ordersToKeep.push(order);
    }
  }

  // Only save and re-render if something actually changed
  if (statusesChanged) {
    localStorage.setItem('orders', JSON.stringify(ordersToKeep));
    updateCartCount();
    
    // Re-render cart if it's open (and show banner if status changed)
    const cartFlyoutBody = document.getElementById('cartFlyoutBody');
    const cartFlyout = document.getElementById('cartFlyout');
    if (cartFlyoutBody && cartFlyout && cartFlyout.classList.contains('show')) {
      renderCartItems();
    }
  }
}

function startStatusPolling() {
  if (statusPollingInterval) return; // Already polling
  
  statusPollingInterval = setInterval(pollOrderStatuses, 30000); // Poll every 30 seconds
  pollOrderStatuses(); // Initial poll immediately
}

function stopStatusPolling() {
  if (statusPollingInterval) {
    clearInterval(statusPollingInterval);
    statusPollingInterval = null;
  }
}

function renderCartItems() {
  const cartFlyoutBody = document.getElementById('cartFlyoutBody');
  if (!cartFlyoutBody) return;
  const orders = JSON.parse(localStorage.getItem('orders') || '[]');
  if (orders.length === 0) {
    cartFlyoutBody.innerHTML = '<p class="cart-empty">No orders yet</p>';
    stopStatusPolling();
    return;
  }
  cartFlyoutBody.innerHTML = orders.map((order, idx) => `
    <div class="cart-item">
      <div class="cart-item-info">
        <p class="recipe">${order.recipe}</p>
        <p class="name">For: ${order.name}</p>
        <p class="order-id" style="font-size: 0.8rem; opacity: 0.6; margin: 4px 0 0;">ID: ${order.id}</p>
        <p class="order-status" style="font-size: 0.85rem; color: #e74; margin: 4px 0 0; font-weight: 600;">${order.status || 'Received'}</p>
      </div>
      <button class="cart-item-remove" data-order-id="${order.id}" type="button">Remove</button>
    </div>
  `).join('');
  // add remove button handlers
  cartFlyoutBody.querySelectorAll('.cart-item-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const orderId = e.target.dataset.orderId;
      const orderToRemove = orders.find(o => o.id === orderId);
      
      // Show custom confirmation modal
      const confirmMsg = document.getElementById('confirmMessage');
      confirmMsg.textContent = `Are you sure? Removing "${orderToRemove.recipe}" from your cart will remove it from the Order Queue.`;
      
      const overlay = document.getElementById('confirmRemovalOverlay');
      overlay.classList.remove('is-hidden');
      overlay.classList.add('active');
      
      // Handle confirm button
      const confirmYesBtn = document.getElementById('confirmYesBtn');
      const confirmNoBtn = document.getElementById('confirmNoBtn');
      
      const handleConfirm = async () => {
        try {
          // Delete order from CF container
          console.log('Attempting to delete order:', orderId);
          const response = await fetch(`https://streeter.cc/api/orders/${orderId}`, {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json'
            }
          });
          
          console.log('Delete response status:', response.status, response.statusText);
          
          if (!response.ok) {
            const errorText = await response.text();
            console.error('Failed to delete order from server:', response.status, errorText);
            // Still delete from local cart even if server delete fails
            const filtered = orders.filter(o => o.id !== orderId);
            localStorage.setItem('orders', JSON.stringify(filtered));
            updateLoginUI();
            renderCartItems();
            closeConfirmModal();
            return;
          }
          
          const result = await response.json();
          console.log('Delete success:', result);
          
          // Remove from local cart
          const filtered = orders.filter(o => o.id !== orderId);
          localStorage.setItem('orders', JSON.stringify(filtered));
          updateLoginUI(); // refresh cart count
          renderCartItems(); // re-render
          closeConfirmModal();
        } catch (error) {
          console.error('Error deleting order:', error);
        }
      };
      
      const handleCancel = () => {
        closeConfirmModal();
      };
      
      const closeConfirmModal = () => {
        overlay.classList.add('is-hidden');
        overlay.classList.remove('active');
        confirmYesBtn.removeEventListener('click', handleConfirm);
        confirmNoBtn.removeEventListener('click', handleCancel);
      };
      
      confirmYesBtn.addEventListener('click', handleConfirm);
      confirmNoBtn.addEventListener('click', handleCancel);
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) handleCancel();
      });
    });
  });
}

    const nav      = document.querySelector('.site-nav');
    const toggle   = document.querySelector('.nav-toggle');
    const sent  = document.getElementById('nav-sentinel');

  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen);
  document.body.classList.toggle('menu-open', isOpen);
  });

  // Close menu when overlay is clicked
  nav.addEventListener('click', (e) => {
    // If clicking the overlay (the ::after pseudo-element appears as a click on nav with nothing underneath)
    if (e.target === nav && nav.classList.contains('open')) {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', false);
      document.body.classList.remove('menu-open');
    }
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
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = loginPassword.value;

    try {
      // Try staff login first
      let authResp = await fetch('https://streeter.cc/api/staff-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      if (authResp.ok) {
        // Staff authentication succeeded
        loginError.classList.add('is-hidden');
        const authData = await authResp.json();
        localStorage.setItem('isStaff', 'true');
        localStorage.setItem('staffToken', authData.token);
        updateLoginUI();
        loginOverlay.classList.remove('active');
        loginForm.reset();
        if (typeof showAuthBanner === 'function') showAuthBanner('Staff authentication');
        // close mobile nav if it's open
        try {
          if (nav && nav.classList.contains('open')) {
            nav.classList.remove('open');
            document.body.classList.remove('menu-open');
            if (toggle && typeof toggle.setAttribute === 'function') toggle.setAttribute('aria-expanded', 'false');
          }
        } catch (e) { /* silent */ }
        return;
      }

      // Try customer login
      authResp = await fetch('https://streeter.cc/api/customer-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      if (authResp.ok) {
        // Customer authentication succeeded
        loginError.classList.add('is-hidden');
        const authData = await authResp.json();
        localStorage.setItem('isCustomer', 'true');
        localStorage.setItem('customerToken', authData.token);
        updateLoginUI();
        loginOverlay.classList.remove('active');
        loginForm.reset();
        if (typeof showAuthBanner === 'function') showAuthBanner('Customer mode enabled');
        // close mobile nav if it's open
        try {
          if (nav && nav.classList.contains('open')) {
            nav.classList.remove('open');
            document.body.classList.remove('menu-open');
            if (toggle && typeof toggle.setAttribute === 'function') toggle.setAttribute('aria-expanded', 'false');
          }
        } catch (e) { /* silent */ }
        return;
      }

      // Both authentication attempts failed
      loginError.textContent = 'Incorrect password';
      loginError.classList.remove('is-hidden');
    } catch (err) {
      console.error('Authentication error:', err);
      loginError.textContent = 'Authentication error. Please try again.';
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

    // show/hide staff orders link
    const staffOrdersLink = document.querySelector('.nav-staff-link');
    if (staffOrdersLink) staffOrdersLink.classList.toggle('is-hidden', !isStaff);

    // show cart for customers and staff, update count
    try {
      const cartWrap = document.getElementById('navCartWrap'); // Desktop
      const cartWrapMobile = document.getElementById('navCartWrapMobile'); // Mobile
      if (cartWrap) cartWrap.classList.toggle('is-hidden', !(isCustomer || isStaff));
      if (cartWrapMobile) cartWrapMobile.classList.toggle('is-hidden', !(isCustomer || isStaff));
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
    localStorage.removeItem('staffToken');
    localStorage.removeItem('customerToken');
    updateLoginUI();
  });

  // Check login status on page load
  updateLoginUI();

  // Nav cart click behavior (placeholder: shows summary banner)
  try {
    const navCartWrap = document.getElementById('navCartWrap'); // Desktop cart
    const navCartWrapMobile = document.getElementById('navCartWrapMobile'); // Mobile cart
    const cartCountEl = document.getElementById('cartCount');
    const cartFlyout = document.getElementById('cartFlyout');
    const cartFlyoutOverlay = document.getElementById('cartFlyoutOverlay');
    const cartFlyoutBody = document.getElementById('cartFlyoutBody');
    const closeCartBtn = document.getElementById('closeCartBtn');

    // Function to open cart flyout
    const openCart = () => {
      cartFlyout.classList.remove('is-hidden');
      cartFlyout.classList.add('show');
      cartFlyoutOverlay.classList.remove('is-hidden');
      cartFlyoutOverlay.classList.add('show');
      renderCartItems();
      // Ensure polling is running whenever cart is open
      startStatusPolling();
    };

    // Open cart flyout - both desktop and mobile cart icons
    if (navCartWrap && cartFlyout && cartFlyoutOverlay) {
      navCartWrap.addEventListener('click', openCart);
    }
    if (navCartWrapMobile && cartFlyout && cartFlyoutOverlay) {
      navCartWrapMobile.addEventListener('click', openCart);
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

    // Refresh status button
    const refreshStatusBtn = document.getElementById('refreshStatusBtn');
    if (refreshStatusBtn) {
      refreshStatusBtn.addEventListener('click', async () => {
        await pollOrderStatuses();
        renderCartItems();
      });
    }

  } catch (e) { /* ignore */ }
