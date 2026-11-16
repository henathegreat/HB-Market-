(function () {
  "use strict";

  const CURRENCY = "ETB";
  const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

  // ---------- Session (only customers can open this page) ----------
  function readStored(key) {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  }

  function logout() {
    ["token", "user"].forEach((key) => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
    window.location.href = "login.html";
  }

  const token = readStored("token");
  let savedUser = null;
  try {
    savedUser = JSON.parse(readStored("user") || "null");
  } catch (e) {
    savedUser = null;
  }

  if (!token || !savedUser) {
    logout();
    return;
  }
  if (savedUser.role !== "consumer") {
    window.location.href = "login.html";
    return;
  }

  // ---------- Small helpers ----------
  const $ = (id) => document.getElementById(id);
  const field = (form, name) => form.querySelector('[name="' + name + '"]');

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function money(amount) {
    return CURRENCY + " " + Number(amount).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function fullName(u) {
    return (u.firstName || "") + " " + (u.lastName || "");
  }

  function avatarHTML(u) {
    if (u.profilePicture) return '<img src="' + esc(u.profilePicture) + '" alt="">';
    const initials = ((u.firstName || "")[0] || "") + ((u.lastName || "")[0] || "");
    return "<span>" + esc(initials.toUpperCase()) + "</span>";
  }

  let toastTimer;
  function toast(message, type) {
    const el = $("toast");
    el.textContent = message;
    el.className = "toast show " + (type || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, 3200);
  }

  async function api(url, options) {
    const opts = options || {};
    const headers = Object.assign({ Authorization: "Bearer " + token }, opts.headers || {});
    const response = await fetch(url, Object.assign({}, opts, { headers }));
    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      logout();
      throw new Error("Please log in again.");
    }
    if (!response.ok) throw new Error(data.message || "Something went wrong.");
    return data;
  }

  // ---------- Form helpers ----------
  function setFieldError(input, message) {
    const box = input.closest(".field");
    box.classList.add("invalid");
    box.querySelector(".error").textContent = message;
    return false;
  }

  function clearFieldErrors(form) {
    form.querySelectorAll(".field").forEach((box) => {
      box.classList.remove("invalid");
      const err = box.querySelector(".error");
      if (err) err.textContent = "";
    });
  }

  function formMessage(el, text, type) {
    el.textContent = text;
    el.className = "form-message show " + type;
  }

  function validateImage(input, maxMB) {
    const file = input.files[0];
    if (!file) return "";
    if (!IMAGE_TYPES.includes(file.type)) return "Only JPG, PNG or WEBP images are allowed.";
    if (file.size > maxMB * 1024 * 1024) return "Image must be " + maxMB + "MB or smaller.";
    return "";
  }

  function bindPreview(input, img, maxMB) {
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file || validateImage(input, maxMB)) {
        img.hidden = true;
        img.removeAttribute("src");
        return;
      }
      img.src = URL.createObjectURL(file);
      img.hidden = false;
    });
  }

  // ---------- Modals ----------
  function openModal(modal) {
    modal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (!document.querySelector(".modal:not([hidden])")) {
      document.body.classList.remove("modal-open");
    }
  }

  // ---------- Views and tabs ----------
  const views = {
    shop: $("viewShop"),
    search: $("viewSearch"),
    producer: $("viewProducer"),
    orders: $("viewOrders"),
    account: $("viewAccount")
  };
  const tabs = document.querySelectorAll(".tab");
  let currentView = "shop";
  let backTo = "shop";

  function showView(name) {
    Object.keys(views).forEach((key) => { views[key].hidden = key !== name; });
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
    currentView = name;
    window.scrollTo(0, 0);
  }

  async function goTo(name) {
    showView(name);
    try {
      if (name === "orders") await loadOrders();
      if (name === "shop") await loadShop();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // ---------- Product cards ----------
  const productIndex = new Map();

  function productCard(p, mode) {
    productIndex.set(p.id, p);

    const img = p.imageUrl
      ? '<img src="' + esc(p.imageUrl) + '" alt="' + esc(p.name) + '" loading="lazy">'
      : '<span class="no-img">📦</span>';

    const inStock = p.stock > 0;

    let by = "";
    if (mode !== "public" && p.producerName) {
      by = '<p class="by">by <a href="#" data-producer-id="' + esc(p.producerId) + '">' + esc(p.producerName) + "</a>" +
        (p.producerNickname ? ' <span class="nick">@' + esc(p.producerNickname) + "</span>" : "") + "</p>";
    }

    return '<article class="product-card">' +
      '<div class="product-img clickable" data-view="' + Number(p.id) + '">' + img + "</div>" +
      '<div class="product-body">' +
      '<h3><a href="#" class="title-link" data-view="' + Number(p.id) + '">' + esc(p.name) + "</a></h3>" +
      '<p class="product-desc">' + esc(p.description) + "</p>" +
      '<div class="product-row"><span class="price">' + money(p.price) + "</span>" +
      '<span class="stock ' + (inStock ? "" : "out") + '">' + (inStock ? p.stock + " in stock" : "Out of stock") + "</span></div>" +
      by +
      '<div class="card-actions"><button type="button" class="mini" data-view="' + Number(p.id) + '">Details</button><button type="button" class="mini add" data-add="' + Number(p.id) + '"' +
      (inStock ? "" : " disabled") + ">" + (inStock ? "Add to cart" : "Out of stock") + "</button></div>" +
      "</div></article>";
  }

  function personCard(u) {
    return '<article class="person-card" data-producer-id="' + esc(u.id) + '" role="button" tabindex="0">' +
      '<div class="avatar-md">' + avatarHTML(u) + "</div>" +
      "<div><h3>" + esc(fullName(u)) + "</h3>" +
      (u.nickname ? '<p class="nick">@' + esc(u.nickname) + "</p>" : "") +
      '<p class="meta">📍 ' + esc(u.city) + ", " + esc(u.country) + "</p></div></article>";
  }

  function fillGrid(grid, empty, items, render) {
    grid.innerHTML = items.map(render).join("");
    empty.hidden = items.length > 0;
  }

  // ---------- Cart (saved in this browser) ----------
  const CART_KEY = "cart_" + savedUser.id;
  let me = null;

  function loadCart() {
    try {
      const data = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
      if (!Array.isArray(data)) return [];
      return data
        .map((i) => ({
          productId: Number(i.productId),
          name: String(i.name || ""),
          price: Number(i.price),
          imageUrl: i.imageUrl ? String(i.imageUrl) : null,
          stock: Number(i.stock) || 0,
          producerName: String(i.producerName || ""),
          quantity: Number(i.quantity)
        }))
        .filter((i) => Number.isInteger(i.productId) && i.productId > 0 &&
          Number.isInteger(i.quantity) && i.quantity > 0 && Number.isFinite(i.price));
    } catch (e) {
      return [];
    }
  }

  let cart = loadCart();

  function saveCart() {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch (e) { /* ignore */ }
  }

  function cartItemHTML(i) {
    const id = Number(i.productId);
    const img = i.imageUrl ? '<img src="' + esc(i.imageUrl) + '" alt="">' : "📦";
    return '<div class="cart-item">' +
      '<div class="cart-thumb">' + img + "</div>" +
      '<div class="cart-info">' +
      "<h4>" + esc(i.name) + "</h4>" +
      (i.producerName ? '<p class="by">by ' + esc(i.producerName) + "</p>" : "") +
      '<p class="price">' + money(i.price) + "</p>" +
      '<div class="qty">' +
      '<button type="button" data-cart-dec="' + id + '" aria-label="Less">−</button>' +
      "<span>" + i.quantity + "</span>" +
      '<button type="button" data-cart-inc="' + id + '" aria-label="More">+</button>' +
      '<button type="button" class="cart-remove" data-cart-remove="' + id + '">Remove</button>' +
      "</div></div></div>";
  }

  function renderCart() {
    const count = cart.reduce((sum, i) => sum + i.quantity, 0);
    const total = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);

    $("cartBadge").textContent = count;
    $("cartBadge").hidden = count === 0;
    $("cartTotal").textContent = money(total);
    $("placeOrderBtn").disabled = cart.length === 0;

    $("cartItems").innerHTML = cart.length
      ? cart.map(cartItemHTML).join("")
      : '<p class="empty">Your cart is empty.</p>';

    $("cartDeliver").textContent = me
      ? "Deliver to: " + me.address + ", " + me.city + ", " + me.country
      : "Delivery uses the address on your account.";
  }

  // Adds a product to the cart. Returns true when it worked.
  function addToCart(id, amount) {
    const p = productIndex.get(id);
    if (!p) return false;

    if (p.stock <= 0) {
      toast("This product is out of stock.", "error");
      return false;
    }

    const wanted = Number.isInteger(amount) && amount > 0 ? amount : 1;
    const existing = cart.find((i) => i.productId === id);
    const inCart = existing ? existing.quantity : 0;

    if (inCart + wanted > p.stock) {
      const room = p.stock - inCart;
      toast(
        room > 0
          ? "You can add only " + room + " more (stock: " + p.stock + ")."
          : "Only " + p.stock + " available, and all are already in your cart.",
        "error"
      );
      return false;
    }

    if (existing) {
      existing.quantity += wanted;
      existing.stock = p.stock;
      existing.price = p.price;
    } else {
      cart.push({
        productId: id,
        name: p.name,
        price: p.price,
        imageUrl: p.imageUrl,
        stock: p.stock,
        producerName: p.producerName || "",
        quantity: wanted
      });
    }

    saveCart();
    renderCart();
    toast("Added to cart.", "success");
    return true;
  }

  function changeQuantity(id, delta) {
    const item = cart.find((i) => i.productId === id);
    if (!item) return;

    const next = item.quantity + delta;
    if (next < 1) return;
    if (delta > 0 && item.stock > 0 && next > item.stock) {
      toast("Only " + item.stock + " available.", "error");
      return;
    }

    item.quantity = next;
    saveCart();
    renderCart();
  }

  function removeFromCart(id) {
    cart = cart.filter((i) => i.productId !== id);
    saveCart();
    renderCart();
  }

  $("cartBtn").addEventListener("click", () => {
    $("cartMessage").className = "form-message";
    renderCart();
    openModal($("cartDrawer"));
  });

  $("placeOrderBtn").addEventListener("click", async () => {
    if (cart.length === 0) return;

    const button = $("placeOrderBtn");
    const message = $("cartMessage");
    message.className = "form-message";
    button.disabled = true;
    button.textContent = "Placing order...";

    try {
      const items = cart.map((i) => ({ productId: i.productId, quantity: i.quantity }));
      const result = await api("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items })
      });

      cart = [];
      saveCart();
      renderCart();
      closeModal($("cartDrawer"));
      toast("Order placed! Now send your payment.", "success");
      await goTo("orders");
      openPayment(result.order.id, result.order.total);
    } catch (err) {
      formMessage(message, err.message, "fail");
    } finally {
      button.textContent = "Place order";
      button.disabled = cart.length === 0;
    }
  });

  // ---------- Product details and price calculator ----------
  let detailProduct = null;

  // The quantity typed in the calculator (never below 1 or above the stock)
  function currentQty() {
    const max = Math.max(detailProduct ? detailProduct.stock : 1, 1);
    const raw = Math.floor(Number($("dQty").value));
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(raw, max);
  }

  function updateCalc() {
    const p = detailProduct;
    if (!p) return;

    const qty = currentQty();
    const totalCents = Math.round(p.price * 100) * qty;

    $("dEach").textContent = money(p.price);
    $("dQtyText").textContent = qty;
    $("dTotal").textContent = money(totalCents / 100);

    const note = $("dNote");
    const typed = Math.floor(Number($("dQty").value));

    if (p.stock <= 0) {
      note.textContent = "This product is out of stock.";
      note.className = "calc-note warn";
    } else if (Number.isFinite(typed) && typed > p.stock) {
      note.textContent = "Only " + p.stock + " in stock, so the total is calculated for " + p.stock + ".";
      note.className = "calc-note warn";
    } else {
      note.textContent = "Final price is confirmed when you place the order.";
      note.className = "calc-note";
    }
  }

  // Loads the other photos of the product and shows them as small pictures
  async function loadDetailGallery(productId) {
    try {
      const data = await api("/api/products/" + encodeURIComponent(productId) + "/images");
      if (!detailProduct || detailProduct.id !== productId || data.images.length < 2) return;

      $("dThumbs").innerHTML = data.images.map((img, index) =>
        '<button type="button" class="thumb-btn' + (index === 0 ? " active" : "") + '" data-thumb="' + esc(img.url) + '">' +
        '<img src="' + esc(img.url) + '" alt=""></button>'
      ).join("");
    } catch (err) {
      // The main photo is already visible, so nothing else to do
    }
  }

  function openDetail(id) {
    const p = productIndex.get(id);
    if (!p) return;
    detailProduct = p;

    $("dImage").innerHTML = p.imageUrl
      ? '<img src="' + esc(p.imageUrl) + '" alt="' + esc(p.name) + '">'
      : "📦";
    $("dTitle").textContent = p.name;
    $("dThumbs").innerHTML = "";
    loadDetailGallery(p.id);
    $("dPrice").textContent = money(p.price);

    const inStock = p.stock > 0;
    const stockEl = $("dStock");
    stockEl.textContent = inStock ? p.stock + " in stock" : "Out of stock";
    stockEl.className = "stock" + (inStock ? "" : " out");

    $("dBy").innerHTML = p.producerName
      ? 'Sold by <a href="#" data-producer-id="' + esc(p.producerId) + '">' + esc(p.producerName) + "</a>" +
        (p.producerNickname ? " @" + esc(p.producerNickname) : "")
      : "";

    $("dDesc").textContent = p.description || "The producer has not added a description yet.";

    $("dQty").value = 1;
    $("dQty").max = inStock ? p.stock : 1;
    ["dQty", "dMinus", "dPlus", "dAddBtn"].forEach((elementId) => { $(elementId).disabled = !inStock; });
    $("dAddBtn").textContent = inStock ? "Add to cart" : "Out of stock";

    updateCalc();
    openModal($("productModal"));
  }

  $("dMinus").addEventListener("click", () => {
    $("dQty").value = Math.max(1, currentQty() - 1);
    updateCalc();
  });

  $("dPlus").addEventListener("click", () => {
    const max = Math.max(detailProduct ? detailProduct.stock : 1, 1);
    $("dQty").value = Math.min(max, currentQty() + 1);
    updateCalc();
  });

  $("dQty").addEventListener("input", updateCalc);

  $("dQty").addEventListener("change", () => {
    $("dQty").value = currentQty();
    updateCalc();
  });

  $("dAddBtn").addEventListener("click", () => {
    if (!detailProduct) return;
    if (addToCart(detailProduct.id, currentQty())) closeModal($("productModal"));
  });

  $("dChatBtn").addEventListener("click", () => {
    if (detailProduct && window.HBChat) window.HBChat.openProduct(detailProduct.id);
  });

  $("messagesBtn").addEventListener("click", () => {
    if (window.HBChat) window.HBChat.openInbox();
  });

  // ---------- Shop ----------
  async function loadShop() {
    const data = await api("/api/shop/products");
    fillGrid($("shopProducts"), $("shopEmpty"), data.products, (p) => productCard(p, "shop"));
  }

  // ---------- Payment (bank transfer receipt) ----------
  let ordersCache = [];
  let payOrder = null;
  let paymentInfo = null;

  // Shows the payment status or the "Pay now" button inside an order card
  function fulfillmentBadge(state) {
    if (state === "shipped") return ' <span class="tag tag-ship">Shipped</span>';
    if (state === "delivered") return ' <span class="tag tag-ok">Delivered</span>';
    return "";
  }

  async function markReceived(orderId) {
    if (!confirm("Confirm that you received your order? Do this only when the products are really in your hands.")) return;

    try {
      await api("/api/orders/" + encodeURIComponent(orderId) + "/received", { method: "POST" });
      toast("Thank you for confirming!", "success");
      await loadOrders();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function paymentHTML(o) {
    const pay = o.payment;

    if (o.status === "pending") {
      if (pay && pay.status === "submitted") {
        return '<p class="pay-state wait">⏳ Receipt sent. Waiting for confirmation.</p>';
      }
      const rejected = pay && pay.status === "rejected"
        ? '<p class="pay-state bad">Your last receipt was rejected' + (pay.note ? ": " + esc(pay.note) : ".") + "</p>"
        : "";
      return rejected + '<button type="button" class="mini add pay-btn" data-pay="' + Number(o.id) + '">Pay now</button>';
    }

    if (o.status === "cancelled") return "";
    const hasShipped = o.items.some((i) => i.fulfillment === "shipped");
    return '<p class="pay-state ok">✓ Payment confirmed</p>' +
      (hasShipped
        ? '<button type="button" class="mini add pay-btn" data-received="' + Number(o.id) + '">I received my order</button>'
        : "");
  }

  function renderPayInfo() {
    const box = $("payInfo");
    const info = paymentInfo;

    if (!info || !info.configured) {
      box.textContent = "Payment details are not available yet. Please contact the platform.";
      return;
    }

    const rows = [
      ["Bank", info.bankName],
      ["Account name", info.accountName],
      ["Account number", info.accountNumber]
    ];
    if (info.telebirrNumber) rows.push(["Telebirr", info.telebirrNumber]);

    box.innerHTML = "<strong>Send the exact amount to:</strong><dl>" +
      rows.map((r) => "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>").join("") +
      "</dl>";
  }

  function updatePayMethod() {
    $("payBankField").hidden = field($("payForm"), "method").value !== "bank_transfer";
  }

  async function openPayment(orderId, total) {
    payOrder = { id: orderId, total: Number(total) };

    const form = $("payForm");
    form.reset();
    clearFieldErrors(form);
    $("payMessage").className = "form-message";
    $("payPreview").hidden = true;

    $("payOrderNo").textContent = "#" + orderId;
    $("payAmount").textContent = money(payOrder.total);
    field(form, "amountPaid").value = (Math.round(payOrder.total * 100) / 100).toFixed(2);
    updatePayMethod();
    openModal($("payModal"));

    try {
      if (!paymentInfo) paymentInfo = await api("/api/payment-info");
      renderPayInfo();
    } catch (err) {
      $("payInfo").textContent = err.message;
    }
  }

  bindPreview($("payReceipt"), $("payPreview"), 4);
  $("payMethod").addEventListener("change", updatePayMethod);

  $("payForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!payOrder) return;

    const form = e.target;
    const message = $("payMessage");
    message.className = "form-message";
    clearFieldErrors(form);

    const method = field(form, "method").value;
    const bank = field(form, "senderBank");
    const reference = field(form, "reference");
    const amount = field(form, "amountPaid");
    const receipt = field(form, "receipt");
    let ok = true;

    if (method === "bank_transfer" && bank.value.trim().length < 2) {
      ok = setFieldError(bank, "Enter the name of your bank.");
    }
    if (!/^[A-Za-z0-9._\/-]{4,60}$/.test(reference.value.trim())) {
      ok = setFieldError(reference, "Enter the reference number from your receipt (4 to 60 letters or numbers).");
    }

    const sent = Number(amount.value);
    if (amount.value === "" || !Number.isFinite(sent) || Math.round(sent * 100) !== Math.round(payOrder.total * 100)) {
      ok = setFieldError(amount, "The amount must be exactly " + money(payOrder.total) + ".");
    }

    if (!receipt.files[0]) {
      ok = setFieldError(receipt, "Please upload your receipt photo.");
    } else {
      const problem = validateImage(receipt, 4);
      if (problem) ok = setFieldError(receipt, problem);
    }

    if (!ok) return;

    const button = $("paySubmit");
    button.disabled = true;
    button.textContent = "Sending...";

    try {
      await api("/api/orders/" + encodeURIComponent(payOrder.id) + "/payment", {
        method: "POST",
        body: new FormData(form)
      });
      closeModal($("payModal"));
      toast("Receipt sent! We will confirm your payment soon.", "success");
      await loadOrders();
    } catch (err) {
      formMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Send receipt";
    }
  });

  // ---------- Orders ----------
  function orderHTML(o) {
    const lines = o.items.map((i) =>
      '<div class="order-line"><span>' + i.quantity + " × " + esc(i.name) +
      ' <small class="muted">by ' + esc(i.producerName) + "</small>" + fulfillmentBadge(i.fulfillment) + "</span>" +
      "<span>" + money(i.subtotal) + "</span></div>"
    ).join("");

    const when = new Date(o.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

    return '<article class="order-card">' +
      '<div class="order-head"><strong>Order #' + Number(o.id) + "</strong>" +
      '<span class="status ' + esc(o.status) + '">' + esc(o.status) + "</span></div>" +
      '<p class="when">' + esc(when) + "</p>" +
      lines +
      '<p class="order-total">Total: ' + money(o.total) + "</p>" +
      paymentHTML(o) +
      "</article>";
  }

  async function loadOrders() {
    const data = await api("/api/orders/mine");
    ordersCache = data.orders;
    $("ordersList").innerHTML = data.orders.map(orderHTML).join("");
    $("ordersEmpty").hidden = data.orders.length > 0;
  }

  // ---------- My account ----------
  function renderAccount(user) {
    me = user;
    $("topAvatar").innerHTML = avatarHTML(user);
    $("acAvatar").innerHTML = avatarHTML(user);
    $("acName").textContent = fullName(user);
    $("acNick").textContent = user.nickname ? "@" + user.nickname : "";
    $("acBio").textContent = user.bio || "";
    $("acEmail").textContent = user.email;
    $("acPhone").textContent = user.phone;
    $("acAddress").textContent = user.address + ", " + user.city + ", " + user.country;
    renderCart();
  }

  async function loadAccount() {
    const data = await api("/api/profile/me");
    renderAccount(data.user);
  }

  bindPreview($("fPhoto"), $("profilePreview"), 2);

  $("openEditProfileBtn").addEventListener("click", () => {
    if (!me) return;
    const form = $("profileForm");
    clearFieldErrors(form);
    $("profileMessage").className = "form-message";
    field(form, "nickname").value = me.nickname || "";
    field(form, "bio").value = me.bio || "";
    field(form, "profilePicture").value = "";
    $("profilePreview").hidden = true;
    openModal($("profileModal"));
  });

  $("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const message = $("profileMessage");
    message.className = "form-message";
    clearFieldErrors(form);

    const nickname = field(form, "nickname");
    const bio = field(form, "bio");
    const photo = field(form, "profilePicture");
    let ok = true;

    if (nickname.value.trim() && !/^[A-Za-z0-9_.-]{3,30}$/.test(nickname.value.trim())) {
      ok = setFieldError(nickname, "Use 3 to 30 characters: letters, numbers, dot, dash or underscore.");
    }
    if (bio.value.length > 300) ok = setFieldError(bio, "Bio must be 300 characters or less.");

    const photoProblem = validateImage(photo, 2);
    if (photoProblem) ok = setFieldError(photo, photoProblem);

    if (!ok) return;

    const button = $("profileSubmit");
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      await api("/api/profile/me", { method: "PUT", body: new FormData(form) });
      closeModal($("profileModal"));
      toast("Profile updated.", "success");
      await loadAccount();
    } catch (err) {
      formMessage(message, err.message, "fail");
    } finally {
      button.disabled = false;
      button.textContent = "Save profile";
    }
  });

  // ---------- Search ----------
  $("searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("searchInput").value.trim();
    const by = $("searchBy").value;

    if (!q) {
      $("searchInput").focus();
      return;
    }

    try {
      const data = await api("/api/search?q=" + encodeURIComponent(q) + "&by=" + encodeURIComponent(by));

      $("searchTitle").textContent = 'Results for "' + q + '"';
      $("searchProductsBox").hidden = by === "producer" || by === "nickname";
      $("searchProducersBox").hidden = by === "product";

      fillGrid($("searchProducts"), $("searchProductsEmpty"), data.products, (p) => productCard(p, "search"));
      fillGrid($("searchProducers"), $("searchProducersEmpty"), data.producers, personCard);

      showView("search");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("clearSearchBtn").addEventListener("click", () => {
    $("searchInput").value = "";
    goTo("shop");
  });

  // ---------- Producer profile ----------
  async function openProducer(id) {
    closeModal($("productModal"));
    if (currentView !== "producer") backTo = currentView;

    try {
      const data = await api("/api/producers/" + encodeURIComponent(id));
      const u = data.producer;

      data.products.forEach((p) => {
        p.producerName = fullName(u);
        p.producerNickname = u.nickname;
      });

      $("pvAvatar").innerHTML = avatarHTML(u);
      $("pvName").textContent = fullName(u);
      $("pvNick").textContent = u.nickname ? "@" + u.nickname : "";
      $("pvBio").textContent = u.bio || "";
      $("pvLocation").textContent = "📍 " + u.city + ", " + u.country;
      $("pvJoined").textContent = "Member since " + new Date(u.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" });

      fillGrid($("pvProducts"), $("pvEmpty"), data.products, (p) => productCard(p, "public"));
      showView("producer");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("backBtn").addEventListener("click", () => showView(backTo));

  // ---------- Navigation and global events ----------
  tabs.forEach((tab) => tab.addEventListener("click", () => goTo(tab.dataset.tab)));
  $("brandLink").addEventListener("click", (e) => { e.preventDefault(); goTo("shop"); });
  $("myAccountBtn").addEventListener("click", () => goTo("account"));
  $("logoutBtn").addEventListener("click", logout);

  document.addEventListener("click", (e) => {
    const producerLink = e.target.closest("[data-producer-id]");
    if (producerLink) {
      e.preventDefault();
      openProducer(producerLink.dataset.producerId);
      return;
    }

    const receivedBtn = e.target.closest("[data-received]");
    if (receivedBtn) {
      markReceived(Number(receivedBtn.dataset.received));
      return;
    }

    const payBtn = e.target.closest("[data-pay]");
    if (payBtn) {
      const order = ordersCache.find((o) => o.id === Number(payBtn.dataset.pay));
      if (order) openPayment(order.id, order.total);
      return;
    }

    const thumbBtn = e.target.closest("[data-thumb]");
    if (thumbBtn) {
      $("dImage").innerHTML = '<img src="' + esc(thumbBtn.dataset.thumb) + '" alt="">';
      document.querySelectorAll("#dThumbs .thumb-btn").forEach((b) => b.classList.toggle("active", b === thumbBtn));
      return;
    }

    const viewBtn = e.target.closest("[data-view]");
    if (viewBtn) {
      e.preventDefault();
      openDetail(Number(viewBtn.dataset.view));
      return;
    }

    const addBtn = e.target.closest("[data-add]");
    if (addBtn) {
      addToCart(Number(addBtn.dataset.add));
      return;
    }

    const incBtn = e.target.closest("[data-cart-inc]");
    if (incBtn) {
      changeQuantity(Number(incBtn.dataset.cartInc), 1);
      return;
    }

    const decBtn = e.target.closest("[data-cart-dec]");
    if (decBtn) {
      changeQuantity(Number(decBtn.dataset.cartDec), -1);
      return;
    }

    const removeBtn = e.target.closest("[data-cart-remove]");
    if (removeBtn) {
      removeFromCart(Number(removeBtn.dataset.cartRemove));
      return;
    }

    const closeBtn = e.target.closest("[data-close]");
    if (closeBtn) {
      closeModal(closeBtn.closest(".modal"));
      return;
    }

    if (e.target.classList.contains("modal")) closeModal(e.target);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal:not([hidden])").forEach(closeModal);
    }
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("person-card")) {
      openProducer(e.target.dataset.producerId);
    }
  });

  // ---------- Start ----------
  $("topAvatar").innerHTML = avatarHTML(savedUser);
  renderCart();

  (async function init() {
    try {
      await Promise.all([loadShop(), loadAccount()]);
    } catch (err) {
      toast(err.message, "error");
    }
  })();
})();
